import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Config } from "../config.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

interface ClassInfo {
  name: string;
  parentClass: string | null;
  filePath: string;
  isModded: boolean;
}

/**
 * Build a class→info index by scanning script files.
 */
function buildClassInfoIndex(
  pakVfs: PakVirtualFS | null,
  basePath: string | null,
  extractedPath?: string
): Map<string, ClassInfo> {
  const index = new Map<string, ClassInfo>();

  function scanContent(content: string, filePath: string) {
    const regex = /^(\s*modded\s+)?class\s+(\w+)\s*(?::\s*(\w+))?/gm;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(content)) !== null) {
      const isModded = !!match[1];
      const className = match[2];
      const parentClass = match[3] ?? null;
      if (!index.has(className)) {
        index.set(className, {
          name: className,
          parentClass,
          filePath,
          isModded,
        });
      }
    }
  }

  // Scan pak scripts
  if (pakVfs) {
    const allPaths = pakVfs.allFilePaths();
    for (const p of allPaths) {
      if (!p.toLowerCase().endsWith(".c")) continue;
      if (pakVfs.fileSize(p) > 512_000) continue;
      try {
        const content = pakVfs.readTextFile(p);
        scanContent(content, p);
      } catch {
        // Skip
      }
    }
  }

  // Scan loose scripts
  if (basePath && existsSync(basePath)) {
    const scriptsDir = join(basePath, "scripts");
    if (existsSync(scriptsDir)) {
      walkScripts(scriptsDir, basePath, scanContent);
    }
  }
  if (extractedPath && existsSync(extractedPath)) {
    const scriptsDir = join(extractedPath, "scripts");
    if (existsSync(scriptsDir)) {
      walkScripts(scriptsDir, extractedPath, scanContent);
    }
  }

  return index;
}

function walkScripts(
  dir: string,
  baseDir: string,
  callback: (content: string, relPath: string) => void,
  depth: number = 0
) {
  if (depth > 10) return;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkScripts(fullPath, baseDir, callback, depth + 1);
    } else if (entry.name.endsWith(".c")) {
      try {
        const content = readFileSync(fullPath, "utf-8");
        const relPath = fullPath.replace(baseDir, "").replace(/^[/\\]/, "").replace(/\\/g, "/");
        callback(content, relPath);
      } catch {
        // Skip
      }
    }
  }
}

export function registerGameClassInfo(server: McpServer, config: Config): void {
  server.registerTool(
    "game_class_info",
    {
      description:
        "Look up detailed information about an Enforce Script class: " +
        "which file defines it, its parent class hierarchy, " +
        "and which other classes extend it. " +
        "Searches across all .pak archives and loose files.",
      inputSchema: {
        className: z
          .string()
          .describe("Class name to look up (e.g., 'SCR_InventoryMenu', 'ChimeraMenuBase')"),
      },
    },
    async ({ className }) => {
      try {
        const pakVfs = PakVirtualFS.get(config.gamePath);
        const basePath = resolveGameDataPath(config.gamePath);
        const classIndex = buildClassInfoIndex(pakVfs, basePath, config.extractedPath);

        const queryLower = className.toLowerCase();
        const info = classIndex.get(className) ?? classIndex.get(
          Array.from(classIndex.keys()).find((k) => k.toLowerCase() === queryLower) ?? ""
        );

        if (!info) {
          // Try partial match
          const matches = Array.from(classIndex.values()).filter(
            (c) => c.name.toLowerCase().includes(queryLower)
          );

          if (matches.length === 0) {
            return {
              content: [{ type: "text", text: `Class "${className}" not found. Index contains ${classIndex.size} classes.` }],
            };
          }

          const lines = [`Class "${className}" not found. Similar classes:\n`];
          for (const m of matches.slice(0, 10)) {
            lines.push(`  ${m.name} → ${m.filePath}${m.isModded ? " (modded)" : ""}`);
          }
          return { content: [{ type: "text", text: lines.join("\n") }] };
        }

        // Build full info
        const lines: string[] = [];
        lines.push(`## Class: ${info.name}`);
        lines.push(`- **File:** ${info.filePath}`);
        lines.push(`- **Modded:** ${info.isModded ? "Yes" : "No"}`);

        // Parent hierarchy
        const hierarchy: string[] = [info.name];
        let current = info.parentClass;
        let depth = 0;
        while (current && depth < 10) {
          hierarchy.push(current);
          const parentInfo = classIndex.get(current);
          current = parentInfo?.parentClass ?? null;
          depth++;
        }
        if (hierarchy.length > 1) {
          lines.push(`- **Hierarchy:** ${hierarchy.join(" → ")}`);
        } else {
          lines.push(`- **Parent:** ${info.parentClass ?? "None (root class)"}`);
        }

        // Find subclasses
        const subclasses = Array.from(classIndex.values()).filter(
          (c) => c.parentClass?.toLowerCase() === info.name.toLowerCase()
        );
        if (subclasses.length > 0) {
          lines.push(`- **Subclasses (${subclasses.length}):**`);
          for (const sub of subclasses.slice(0, 20)) {
            lines.push(`  - ${sub.name} → ${sub.filePath}`);
          }
          if (subclasses.length > 20) {
            lines.push(`  ... and ${subclasses.length - 20} more`);
          }
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error looking up class: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
