import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

interface AssetEntry {
  /** Relative path from game data root (e.g., "Prefabs/Weapons/Rifles/AK47/AK47.et") */
  path: string;
  /** File extension without dot */
  ext: string;
  /** Resource GUID from entity catalog, if available (e.g., "657590C1EC9E27D3") */
  guid?: string;
}

const ASSET_EXTENSIONS = new Set([".et", ".xob", ".edds", ".c", ".conf", ".emat", ".layout", ".sounds"]);

const TYPE_FILTER: Record<string, string[]> = {
  prefab: [".et"],
  model: [".xob"],
  texture: [".edds"],
  script: [".c"],
  config: [".conf"],
  material: [".emat"],
  layout: [".layout"],
};

/** Resource references in entity catalog configs, e.g.
 *  m_sEntityPrefab "{657590C1EC9E27D3}Prefabs/Groups/OPFOR/Group_USSR_LightFireTeam.et" */
export const CATALOG_GUID_PATTERN = /\{([0-9A-Fa-f]{16})\}\s*([^\s"]+\.et)/g;

/** Generic resource references (layouts, imagesets, textures, fonts, configs, materials), e.g.
 *  Layout "{C5D8399074D02270}UI/layouts/Menus/MainMenu/MainMenu.layout"
 *  path "{403EEC9EC77AE359}UI/Textures/Icons/icons_mapMarkersUI-glow_atlas.edds"
 *  static const ResourceName LAYOUT = "{681D3C8C634F895F}UI/layouts/Editor/Saving/Save.layout" */
export const REF_GUID_PATTERN = /\{([0-9A-Fa-f]{16})\}\s*([^\s"{}(]+\.(?:layout|imageset|edds|fnt|conf|emat))\b/g;

/** Cached file index — built once per session */
let cachedIndex: AssetEntry[] | null = null;
let cachedBasePath: string | null = null;
let cachedGuidDiag = "";

/**
 * Collect GUID→resource-path pairs from a text chunk, writing into guidMap.
 * Returns how many new pairs were added.
 */
export function scanGuidChunk(
  guidMap: Map<string, string>,
  chunk: string,
  pattern: RegExp
): number {
  let added = 0;
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(chunk)) !== null) {
    const guid = match[1].toUpperCase();
    const resPath = match[2].replace(/\\/g, "/").toLowerCase();
    if (!guidMap.has(resPath)) {
      guidMap.set(resPath, guid);
      added++;
    }
  }
  return added;
}

/**
 * Build a map of normalized resource path → GUID.
 * GUIDs are embedded directly in game content (vanilla packs strip .meta headers),
 * so they are mined from:
 *   1. Loose entity catalog .conf files on disk (unpacked base game data).
 *   2. Entity catalog .conf files inside .pak archives (packed base game data) → prefabs.
 *   3. UI references inside packed menu presets (Configs/System/chimeraMenus.conf),
 *      all .layout files and all .imageset files → layouts, textures, imagesets, fonts.
 *   4. Enforce scripts and Configs/System configs → resources named in code attributes/consts.
 */
export function buildGuidIndex(
  basePath: string,
  pakVfs: PakVirtualFS | null,
  pakPaths: string[]
): { guidMap: Map<string, string>; diag: string } {
  const guidMap = new Map<string, string>();
  let catalogCount = 0;
  let refCount = 0;

  // 1. Loose entity catalogs (base game unpacked)
  function walkCatalogs(dir: string): void {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walkCatalogs(fullPath);
      } else if (entry.name.toLowerCase().endsWith(".conf") &&
                 dir.toLowerCase().includes("entitycatalog")) {
        catalogCount++;
        try {
          refCount += scanGuidChunk(guidMap, readFileSync(fullPath, "utf-8"), CATALOG_GUID_PATTERN);
        } catch (e) {
          logger.warn(`GUID index: failed to read catalog ${fullPath}: ${e}`);
        }
      }
    }
  }
  walkCatalogs(basePath);

  if (pakVfs) {
    // 2. Packed entity catalogs → prefab (.et) GUIDs
    for (const p of pakPaths) {
      const low = p.toLowerCase();
      if (!low.endsWith(".conf") || !low.includes("entitycatalog")) continue;
      catalogCount++;
      try {
        refCount += scanGuidChunk(guidMap, pakVfs.readTextFile(p), CATALOG_GUID_PATTERN);
      } catch (e) {
        logger.warn(`GUID index: failed to read catalog ${p}: ${e}`);
      }
    }

    // 3. Packed UI references → layout/imageset/edds/fnt GUIDs
    for (const p of pakPaths) {
      const low = p.toLowerCase();
      if (low === "configs/system/chimeramenus.conf" ||
          low.endsWith(".layout") ||
          low.endsWith(".imageset")) {
        try {
          refCount += scanGuidChunk(guidMap, pakVfs.readTextFile(p), REF_GUID_PATTERN);
        } catch (e) {
          logger.warn(`GUID index: failed to scan refs in ${p}: ${e}`);
        }
      }
    }

    // 4. Scripts and system configs → resources referenced from code (layouts, fonts, textures, confs)
    for (const p of pakPaths) {
      const low = p.toLowerCase();
      const isScript = low.endsWith(".c");
      const isSystemConf = low.startsWith("configs/system/") && low.endsWith(".conf");
      if (!isScript && !isSystemConf) continue;
      if (pakVfs.fileSize(p) > 262144) continue; // skip very large files
      try {
        refCount += scanGuidChunk(guidMap, pakVfs.readTextFile(p), REF_GUID_PATTERN);
      } catch (e) {
        logger.warn(`GUID index: failed to scan refs in ${p}: ${e}`);
      }
    }
  }

  const diag = `${guidMap.size} GUIDs from ${catalogCount} catalogs + ${refCount} references (loose+pak)`;
  logger.info(`GUID index built: ${diag}`);
  return { guidMap, diag };
}

function buildIndex(basePath: string, gamePath: string): AssetEntry[] {
  const start = Date.now();
  const entries: AssetEntry[] = [];
  const seen = new Set<string>();

  // 1. Walk loose (unpacked) files first — they take priority
  function walk(dir: string): void {
    let dirEntries;
    try {
      dirEntries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // Skip unreadable directories
    }

    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) continue;

      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else {
        const ext = extname(entry.name).toLowerCase();
        if (ASSET_EXTENSIONS.has(ext)) {
          const relPath = relative(basePath, fullPath).replace(/\\/g, "/");
          entries.push({ path: relPath, ext: ext.slice(1) });
          seen.add(relPath.toLowerCase());
        }
      }
    }
  }

  walk(basePath);

  // 2. Resolve pak archive contents (lazily initialized, cached per game path)
  let pakVfs: PakVirtualFS | null = null;
  let pakPaths: string[] = [];
  try {
    pakVfs = PakVirtualFS.get(gamePath);
    if (pakVfs) {
      pakPaths = pakVfs.allFilePaths();
    }
  } catch (e) {
    logger.warn(`Failed to init pak VFS: ${e}`);
  }

  // 3. Build GUID index from entity catalogs (loose + packed) and UI resource references
  let guidMap: Map<string, string> | null = null;
  try {
    const { guidMap: gm, diag } = buildGuidIndex(basePath, pakVfs, pakPaths);
    guidMap = gm;
    cachedGuidDiag = diag;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    cachedGuidDiag = `GUID INDEX ERROR: ${msg}`;
    logger.warn(`Failed to build GUID index: ${e}`);
  }

  // 4. Add entries from .pak files (skip duplicates already found as loose files)
  try {
    if (pakVfs) {
      for (const filePath of pakPaths) {
        if (seen.has(filePath.toLowerCase())) continue;
        const ext = extname(filePath).toLowerCase();
        if (ASSET_EXTENSIONS.has(ext)) {
          entries.push({ path: filePath, ext: ext.slice(1) });
        }
      }
    }
  } catch (e) {
    logger.warn(`Failed to index pak files: ${e}`);
  }

  // 5. Attach GUIDs to all matched entries (prefabs, layouts, textures, imagesets, fonts)
  if (guidMap && guidMap.size > 0) {
    for (const entry of entries) {
      const pathLower = entry.path.toLowerCase();
      let g = guidMap.get(pathLower) ?? null;
      if (!g) {
        // Loose paths may include a base data segment catalogs don't (e.g. DataXXX/data005)
        const slashIdx = pathLower.indexOf("/");
        if (slashIdx !== -1) {
          g = guidMap.get(pathLower.slice(slashIdx + 1)) ?? null;
        }
      }
      if (g) entry.guid = g;
    }
  }

  const guidCount = entries.filter((e) => e.guid).length;
  const elapsed = Date.now() - start;
  logger.info(`Asset index built: ${entries.length} files, ${guidCount} with GUIDs, in ${elapsed}ms`);
  return entries;
}

export function invalidateAssetCache(): void {
  cachedIndex = null;
  cachedBasePath = null;
  cachedGuidDiag = "";
}

function getIndex(basePath: string, gamePath: string): AssetEntry[] {
  if (cachedIndex && cachedBasePath === basePath) {
    return cachedIndex;
  }
  cachedIndex = buildIndex(basePath, gamePath);
  cachedBasePath = basePath;
  return cachedIndex;
}

export function registerAssetSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "asset_search",
    {
      description:
        "Search for base game assets (prefabs, models, textures, scripts, configs) by name. " +
        "Searches both unpacked files and .pak archives transparently. " +
        "Returns file paths and GUIDs (prefabs, layouts, textures, imagesets, fonts — mined from " +
        "packed entity catalogs and UI references) that can be used in resource references. " +
        "The first search may take a few seconds to build the file index.",
      inputSchema: {
        query: z
          .string()
          .describe("Search term to match against file names (e.g., 'AK47', 'BarrelGreen', 'soldier')"),
        type: z
          .enum(["prefab", "model", "texture", "script", "config", "material", "layout", "any"])
          .default("any")
          .describe("Filter by asset type"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(20)
          .describe("Maximum results to return"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Force rebuild of the file index (clears cache). Use if results seem stale."),
      },
    },
    async ({ query, type, limit, refresh }) => {
      if (refresh) {
        invalidateAssetCache();
      }
      const basePath = resolveGameDataPath(config.gamePath);
      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: `Base game not found at ${config.gamePath}. Set ENFUSION_GAME_PATH or ensure Arma Reforger is installed.`,
            },
          ],
          isError: true,
        };
      }

      try {
        const index = getIndex(basePath, config.gamePath);
        const q = query.toLowerCase();
        const allowedExts = type !== "any" ? TYPE_FILTER[type] : null;

        const results: Array<{ entry: AssetEntry; score: number }> = [];

        for (const entry of index) {
          // Filter by type
          if (allowedExts && !allowedExts.includes(`.${entry.ext}`)) continue;

          // Score by filename match (not full path — filename is most relevant)
          const pathLower = entry.path.toLowerCase();
          const segments = entry.path.split("/");
          const filename = (segments[segments.length - 1] ?? "").toLowerCase();

          let score = 0;
          if (filename === q || filename === `${q}.${entry.ext}`) {
            score = 100; // Exact filename match
          } else if (filename.startsWith(q)) {
            score = 80; // Filename prefix
          } else if (filename.includes(q)) {
            score = 60; // Filename substring
          } else if (pathLower.includes(q)) {
            score = 30; // Path substring
          }

          if (score > 0) {
            results.push({ entry, score });
          }
        }

        results.sort((a, b) => b.score - a.score);
        const shown = results.slice(0, limit);

        if (shown.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No ${type !== "any" ? type + " " : ""}assets found matching "${query}". Index contains ${index.length} files.`,
              },
            ],
          };
        }

        const guidTotal = index.filter((e) => e.guid).length;
        const lines: string[] = [];
        const diagInfo = `GUIDs:${cachedGuidDiag || `0(empty)`}|basePath:${basePath}|gamePath:${config.gamePath}|indexSize:${index.length}`;
        lines.push(`Found ${results.length} match${results.length !== 1 ? "es" : ""} (showing ${shown.length}) [${diagInfo}]:\n`);

        for (const { entry } of shown) {
          if (entry.guid) {
            lines.push(`  {${entry.guid}}${entry.path}`);
          } else {
            lines.push(`  ${entry.path}`);
          }
        }

        if (results.length > limit) {
          lines.push(`\n  ... and ${results.length - limit} more results`);
        }

        if (cachedGuidDiag && cachedGuidDiag.startsWith("GUID INDEX ERROR")) {
          lines.push("");
          lines.push(`**Warning:** ${cachedGuidDiag}`);
          lines.push("Some results may be missing GUID prefixes. Check file permissions or game installation.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error searching assets: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}
