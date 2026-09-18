import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";
import { logger } from "../utils/logger.js";

/** Extensions to search for class definitions */
const SCRIPT_EXTENSIONS = [".c"];
/** Extensions to search for references (scripts + configs) */
const REFERENCE_EXTENSIONS = [".c", ".conf", ".layout", ".et"];

/**
 * Extract class names from a script file content.
 * Matches: `class Foo`, `modded class Foo`, `class Foo : Bar`
 */
function extractClassNames(content: string): string[] {
  const classes: string[] = [];
  const regex = /(?:modded\s+)?class\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    classes.push(match[1]);
  }
  return classes;
}

/**
 * Build a class→file index by scanning script files in the VFS.
 * Returns a map of lowercase class name → file path.
 */
function buildClassIndex(
  pakVfs: PakVirtualFS | null,
  loosePath: string | null,
  extractedPath?: string
): Map<string, string> {
  const classIndex = new Map<string, string>();
  const scanned = new Set<string>();

  function scanContent(content: string, filePath: string) {
    const classes = extractClassNames(content);
    for (const cls of classes) {
      const lower = cls.toLowerCase();
      if (!classIndex.has(lower)) {
        classIndex.set(lower, filePath);
      }
    }
  }

  // 1. Scan loose script files
  if (loosePath && existsSync(loosePath)) {
    const scriptsDir = join(loosePath, "scripts");
    if (existsSync(scriptsDir)) {
      walkScripts(scriptsDir, (filePath, content) => {
        const rel = relative(loosePath, filePath).replace(/\\/g, "/");
        scanContent(content, rel);
        scanned.add(rel.toLowerCase());
      });
    }
  }

  // 2. Scan extracted path
  if (extractedPath && existsSync(extractedPath)) {
    const scriptsDir = join(extractedPath, "scripts");
    if (existsSync(scriptsDir)) {
      walkScripts(scriptsDir, (filePath, content) => {
        const rel = relative(extractedPath, filePath).replace(/\\/g, "/");
        if (!scanned.has(rel.toLowerCase())) {
          scanContent(content, rel);
          scanned.add(rel.toLowerCase());
        }
      });
    }
  }

  // 3. Scan pak script files
  if (pakVfs) {
    const allPaths = pakVfs.allFilePaths();
    for (const p of allPaths) {
      if (!p.toLowerCase().endsWith(".c")) continue;
      if (pakVfs.fileSize(p) > 512_000) continue;
      try {
        const content = pakVfs.readTextFile(p);
        scanContent(content, p);
      } catch {
        // Skip unreadable
      }
    }
  }

  return classIndex;
}

function walkScripts(dir: string, callback: (filePath: string, content: string) => void) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkScripts(fullPath, callback);
    } else if (entry.name.endsWith(".c")) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        callback(fullPath, content);
      } catch {
        // Skip unreadable
      }
    }
  }
}

export function registerGameSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "game_search",
    {
      description:
        "Search for base game files by name pattern, class name, GUID, or content reference. " +
        "Searches across all .pak archives and loose files. " +
        "Use this to find the correct file path before calling game_read. " +
        "Four search modes: " +
        "filename (find files by name), " +
        "class (find which .c defines a class), " +
        "guid (find prefab by GUID), " +
        "reference (find files that reference a class/name).",
      inputSchema: {
        query: z
          .string()
          .describe(
            "Search query. For filename: pattern like 'InventoryMenu' or '*Inventory*.c'. " +
            "For class: class name like 'SCR_InventoryMenu'. " +
            "For guid: GUID like '{657590C1EC9E27D3}' or '657590C1EC9E27D3'. " +
            "For reference: class or symbol name like 'SCR_InventoryMenu'."
          ),
        mode: z
          .enum(["filename", "class", "guid", "reference"])
          .default("filename")
          .describe(
            "Search mode: " +
            "'filename' — find files by name pattern (glob/substring), " +
            "'class' — find which .c file defines a given class, " +
            "'guid' — find resource by GUID, " +
            "'reference' — find all files that reference a class/symbol."
          ),
        type: z
          .enum(["script", "prefab", "config", "layout", "texture", "any"])
          .default("any")
          .describe("Filter by file extension type"),
        limit: z
          .number()
          .min(1)
          .max(100)
          .default(30)
          .describe("Maximum results to return"),
        refresh: z
          .boolean()
          .default(false)
          .describe("Force rebuild of class index (class/reference modes only)"),
      },
    },
    async ({ query, mode, type, limit, refresh }) => {
      const basePath = resolveGameDataPath(config.gamePath);
      const extractedPath = config.extractedPath;

      try {
        const pakVfs = PakVirtualFS.get(config.gamePath);

        // ── GUID mode ────────────────────────────────────────────────────
        if (mode === "guid") {
          const guidMatch = query.match(/\{?([0-9A-Fa-f]{16})\}?/);
          if (!guidMatch) {
            return {
              content: [{ type: "text", text: `Invalid GUID format: "${query}". Expected 16 hex characters, e.g., {657590C1EC9E27D3}` }],
              isError: true,
            };
          }
          const guid = guidMatch[1].toUpperCase();
          const extFilter = TYPE_MAP[type] ?? null;

          // Search all file paths for the GUID
          const results: string[] = [];
          if (pakVfs) {
            const allPaths = pakVfs.allFilePaths();
            for (const p of allPaths) {
              if (results.length >= limit) break;
              const ext = extname(p).toLowerCase();
              if (extFilter && !extFilter.includes(ext)) continue;

              if (p.toLowerCase().includes(guid.toLowerCase())) {
                results.push(p);
              }
            }
          }

          // Also check loose files and extracted path
          if (basePath && existsSync(basePath)) {
            searchLooseForGuid(basePath, guid, extFilter, results, limit);
          }
          if (extractedPath && existsSync(extractedPath)) {
            searchLooseForGuid(extractedPath, guid, extFilter, results, limit);
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No files found containing GUID ${guid}. The GUID may not exist in the game data.` }],
            };
          }

          const lines = [`Found ${results.length} file(s) matching GUID {${guid}}:\n`];
          for (const r of results) {
            lines.push(`  ${r}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // ── Class mode ───────────────────────────────────────────────────
        if (mode === "class") {
          const classIndex = buildClassIndex(pakVfs, basePath, extractedPath);
          const queryLower = query.toLowerCase();

          // Exact match first
          const exact = classIndex.get(queryLower);
          // Prefix matches
          const prefixMatches: Array<{ className: string; path: string }> = [];
          // Substring matches
          const subMatches: Array<{ className: string; path: string }> = [];

          for (const [cls, path] of classIndex) {
            if (cls === queryLower) continue; // already handled
            if (cls.startsWith(queryLower)) {
              prefixMatches.push({ className: cls, path });
            } else if (cls.includes(queryLower)) {
              subMatches.push({ className: cls, path });
            }
          }

          if (!exact && prefixMatches.length === 0 && subMatches.length === 0) {
            return {
              content: [{ type: "text", text: `No class found matching "${query}". Index contains ${classIndex.size} classes.` }],
            };
          }

          const lines: string[] = [];
          if (exact) {
            lines.push(`Class "${query}" defined in:\n  ${exact}\n`);
          }

          const allMatches = [...prefixMatches, ...subMatches].slice(0, limit - (exact ? 1 : 0));
          if (allMatches.length > 0) {
            if (!exact) {
              lines.push(`No exact match for "${query}". Similar classes:\n`);
            } else {
              lines.push(`Similar classes:\n`);
            }
            for (const m of allMatches) {
              lines.push(`  ${m.className} → ${m.path}`);
            }
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // ── Reference mode ───────────────────────────────────────────────
        if (mode === "reference") {
          const extFilter = TYPE_MAP[type] ?? REFERENCE_EXTENSIONS;
          const results: Array<{ path: string; line?: number; context?: string }> = [];

          // Search pak files
          if (pakVfs) {
            const allPaths = pakVfs.allFilePaths();
            for (const p of allPaths) {
              if (results.length >= limit) break;
              const ext = extname(p).toLowerCase();
              if (!extFilter.includes(ext)) continue;
              if (pakVfs.fileSize(p) > 512_000) continue;

              try {
                const content = pakVfs.readTextFile(p);
                const lower = content.toLowerCase();
                const queryLower = query.toLowerCase();
                if (lower.includes(queryLower)) {
                  // Find the line with the reference
                  const lines = content.split("\n");
                  for (let i = 0; i < lines.length; i++) {
                    if (lines[i].toLowerCase().includes(queryLower)) {
                      results.push({
                        path: p,
                        line: i + 1,
                        context: lines[i].trim().substring(0, 120),
                      });
                      break;
                    }
                  }
                }
              } catch {
                // Skip unreadable
              }
            }
          }

          // Search loose files
          if (basePath && existsSync(basePath)) {
            searchLooseForRef(basePath, query, extFilter, results, limit);
          }
          if (extractedPath && existsSync(extractedPath)) {
            searchLooseForRef(extractedPath, query, extFilter, results, limit);
          }

          if (results.length === 0) {
            return {
              content: [{ type: "text", text: `No files found referencing "${query}".` }],
            };
          }

          const lines = [`Found ${results.length} file(s) referencing "${query}":\n`];
          for (const r of results) {
            if (r.context) {
              lines.push(`  ${r.path}:${r.line}`);
              lines.push(`    ${r.context}`);
            } else {
              lines.push(`  ${r.path}`);
            }
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // ── Filename mode (default) ──────────────────────────────────────
        const extFilter = TYPE_MAP[type] ?? null;
        const results: Array<{ path: string; score: number }> = [];

        // Search VFS
        if (pakVfs) {
          const matches = pakVfs.searchFiles(query, limit * 2);
          for (const p of matches) {
            const ext = extname(p).toLowerCase();
            if (extFilter && !extFilter.includes(ext)) continue;
            // Score: exact=100, prefix=80, contains=60 (from VFS search)
            const filename = p.split("/").pop()?.toLowerCase() ?? "";
            const queryLower = query.toLowerCase();
            let score = 0;
            if (filename === queryLower || filename === `${queryLower}${ext}`) score = 100;
            else if (filename.startsWith(queryLower)) score = 80;
            else if (filename.includes(queryLower)) score = 60;
            else score = 30;

            results.push({ path: p, score });
            if (results.length >= limit) break;
          }
        }

        // Search loose files
        if (basePath && existsSync(basePath)) {
          searchLooseForFilename(basePath, query, extFilter, results, limit);
        }
        if (extractedPath && existsSync(extractedPath)) {
          searchLooseForFilename(extractedPath, query, extFilter, results, limit);
        }

        // Deduplicate and sort
        const seen = new Set<string>();
        const unique = results.filter((r) => {
          const key = r.path.toLowerCase();
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });
        unique.sort((a, b) => b.score - a.score);
        const shown = unique.slice(0, limit);

        if (shown.length === 0) {
          return {
            content: [{ type: "text", text: `No files found matching "${query}" (type: ${type}). Try a different search term or mode.` }],
          };
        }

        const lines = [`Found ${unique.length} match${unique.length !== 1 ? "es" : ""} (showing ${shown.length}):\n`];
        for (const { path } of shown) {
          lines.push(`  ${path}`);
        }
        if (unique.length > limit) {
          lines.push(`\n  ... and ${unique.length - limit} more`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error searching game files: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}

// ── Type filter map ─────────────────────────────────────────────────────────

const TYPE_MAP: Record<string, string[]> = {
  script: [".c"],
  prefab: [".et"],
  config: [".conf"],
  layout: [".layout"],
  texture: [".edds"],
};

// ── Loose file search helpers ───────────────────────────────────────────────

function searchLooseForFilename(
  basePath: string,
  query: string,
  extFilter: string[] | null,
  results: Array<{ path: string; score: number }>,
  limit: number
) {
  const queryLower = query.toLowerCase();
  walkLoose(basePath, (filePath, relPath) => {
    if (results.length >= limit) return;
    const ext = extname(relPath).toLowerCase();
    if (extFilter && !extFilter.includes(ext)) return;

    const filename = relPath.split("/").pop()?.toLowerCase() ?? "";
    let score = 0;
    if (filename === queryLower || filename === `${queryLower}${ext}`) score = 95;
    else if (filename.startsWith(queryLower)) score = 75;
    else if (filename.includes(queryLower)) score = 55;
    else if (relPath.toLowerCase().includes(queryLower)) score = 25;

    if (score > 0) {
      results.push({ path: relPath, score });
    }
  });
}

function searchLooseForRef(
  basePath: string,
  query: string,
  extFilter: string[],
  results: Array<{ path: string; line?: number; context?: string }>,
  limit: number
) {
  const queryLower = query.toLowerCase();
  walkLoose(basePath, (filePath, relPath) => {
    if (results.length >= limit) return;
    const ext = extname(relPath).toLowerCase();
    if (!extFilter.includes(ext)) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.toLowerCase().includes(queryLower)) {
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            results.push({ path: relPath, line: i + 1, context: lines[i].trim().substring(0, 120) });
            break;
          }
        }
      }
    } catch {
      // Skip
    }
  });
}

function searchLooseForGuid(
  basePath: string,
  guid: string,
  extFilter: string[] | null,
  results: string[],
  limit: number
) {
  const guidLower = guid.toLowerCase();
  walkLoose(basePath, (filePath, relPath) => {
    if (results.length >= limit) return;
    const ext = extname(relPath).toLowerCase();
    if (extFilter && !extFilter.includes(ext)) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      if (content.toLowerCase().includes(guidLower)) {
        results.push(relPath);
      }
    } catch {
      // Skip
    }
  });
}

function walkLoose(dir: string, callback: (filePath: string, relPath: string) => void, baseDir?: string) {
  const base = baseDir ?? dir;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkLoose(fullPath, callback, base);
    } else {
      const relPath = relative(base, fullPath).replace(/\\/g, "/");
      callback(fullPath, relPath);
    }
  }
}
