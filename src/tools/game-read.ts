import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

/** Extensions that are safe to read as text */
const TEXT_EXTENSIONS = new Set([
  ".c", ".et", ".conf", ".gproj", ".ent", ".layer", ".st",
  ".layout", ".txt", ".json", ".xml", ".csv",
  ".imageset", ".styles", ".fnt", ".sig", ".siga",
]);

/**
 * Find fuzzy matches for a file path in the VFS and loose directories.
 * Returns up to 8 suggestions sorted by relevance.
 */
function findSuggestions(
  subPath: string,
  pakVfs: PakVirtualFS | null,
  basePath: string | null,
  extractedPath?: string
): string[] {
  const suggestions: Array<{ path: string; score: number }> = [];
  const filename = subPath.split(/[\\/]/).pop()?.toLowerCase() ?? "";
  const basename = filename.replace(/\.[^.]+$/, "");

  if (!basename) return [];

  // Search VFS
  if (pakVfs) {
    const matches = pakVfs.searchFiles(basename, 20);
    for (const m of matches) {
      const mFilename = m.split("/").pop()?.toLowerCase() ?? "";
      let score = 0;
      if (mFilename === filename) score = 100;
      else if (mFilename.startsWith(basename)) score = 80;
      else if (mFilename.includes(basename)) score = 60;
      else score = 30;
      suggestions.push({ path: m, score });
    }
  }

  // Search loose files
  if (basePath && existsSync(basePath)) {
    searchLooseForSuggestions(basePath, basename, filename, suggestions);
  }
  if (extractedPath && existsSync(extractedPath)) {
    searchLooseForSuggestions(extractedPath, basename, filename, suggestions);
  }

  // Deduplicate, sort by score, return top 8
  const seen = new Set<string>();
  return suggestions
    .filter((s) => {
      const key = s.path.toLowerCase();
      if (seen.has(key) || key === subPath.toLowerCase()) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 8)
    .map((s) => s.path);
}

function searchLooseForSuggestions(
  basePath: string,
  basename: string,
  filename: string,
  results: Array<{ path: string; score: number }>
) {
  const scriptsDir = join(basePath, "scripts");
  if (existsSync(scriptsDir)) {
    walkForSuggestions(scriptsDir, basePath, basename, filename, results);
  }
  // Also check other common directories
  for (const dir of ["Prefabs", "Configs", "UI"]) {
    const target = join(basePath, dir);
    if (existsSync(target)) {
      walkForSuggestions(target, basePath, basename, filename, results);
    }
  }
}

function walkForSuggestions(
  dir: string,
  baseDir: string,
  basename: string,
  filename: string,
  results: Array<{ path: string; score: number }>,
  depth: number = 0
) {
  if (depth > 8) return; // limit recursion
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (results.length >= 20) return;
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkForSuggestions(fullPath, baseDir, basename, filename, results, depth + 1);
    } else {
      const entryLower = entry.name.toLowerCase();
      let score = 0;
      if (entryLower === filename) score = 95;
      else if (entryLower.startsWith(basename)) score = 75;
      else if (entryLower.includes(basename)) score = 55;
      if (score > 0) {
        const relPath = relative(baseDir, fullPath).replace(/\\/g, "/");
        results.push({ path: relPath, score });
      }
    }
  }
}

export function registerGameRead(server: McpServer, config: Config): void {
  server.registerTool(
    "game_read",
    {
      description:
        "Read a file from the base game data. " +
        "Reads from unpacked files, .pak archives, and extracted libraries transparently. " +
        "Use this to read vanilla .c script files to understand what to override, " +
        "or inspect prefab .et files and config .conf files. " +
        "When a file is not found, suggests similar files that may be what you're looking for.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "Relative path within the game data (e.g., 'Scripts/Game/Character/SCR_CharacterControllerComponent.c')"
          ),
      },
    },
    async ({ path: subPath }) => {
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
        const filePath = validateProjectPath(basePath, subPath);

        // Try loose file first
        if (existsSync(filePath)) {
          const stats = statSync(filePath);
          if (stats.isDirectory()) {
            return {
              content: [
                {
                  type: "text",
                  text: `"${subPath}" is a directory. Use game_browse to list its contents.`,
                },
              ],
            };
          }

          const ext = extname(filePath).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Binary file: ${subPath} (${ext}, ${stats.size} bytes). Only text files (.c, .et, .conf, etc.) can be read.`,
                },
              ],
            };
          }

          if (stats.size > 512_000) {
            return {
              content: [
                {
                  type: "text",
                  text: `File too large: ${subPath} (${(stats.size / 1024).toFixed(0)} KB). Maximum readable size is 500 KB.`,
                },
              ],
            };
          }

          const content = readFileSync(filePath, "utf-8");
          return {
            content: [
              {
                type: "text",
                text: `// ${subPath}\n// ${stats.size} bytes\n\n${content}`,
              },
            ],
          };
        }

        // Try extractedPath
        if (config.extractedPath && existsSync(config.extractedPath)) {
          const extractedFile = join(config.extractedPath, subPath);
          if (existsSync(extractedFile)) {
            const stats = statSync(extractedFile);
            if (stats.isFile()) {
              const ext = extname(extractedFile).toLowerCase();
              if (TEXT_EXTENSIONS.has(ext) && stats.size <= 512_000) {
                const content = readFileSync(extractedFile, "utf-8");
                return {
                  content: [
                    {
                      type: "text",
                      text: `// ${subPath} (from extracted library)\n// ${stats.size} bytes\n\n${content}`,
                    },
                  ],
                };
              }
            }
          }
        }

        // Fall through to pak VFS
        const pakVfs = PakVirtualFS.get(config.gamePath);
        if (pakVfs && pakVfs.exists(subPath)) {
          const ext = extname(subPath).toLowerCase();
          if (!TEXT_EXTENSIONS.has(ext)) {
            return {
              content: [
                {
                  type: "text",
                  text: `Binary file: ${subPath} (${ext}). Only text files (.c, .et, .conf, etc.) can be read.`,
                },
              ],
            };
          }

          const fileSize = pakVfs.fileSize(subPath);
          if (fileSize > 512_000) {
            return {
              content: [
                {
                  type: "text",
                  text: `File too large: ${subPath} (${(fileSize / 1024).toFixed(0)} KB). Maximum readable size is 500 KB.`,
                },
              ],
            };
          }

          const content = pakVfs.readTextFile(subPath);
          return {
            content: [
              {
                type: "text",
                text: `// ${subPath} (from .pak)\n// ${content.length} bytes\n\n${content}`,
              },
            ],
          };
        }

        // File not found — find suggestions
        const suggestions = findSuggestions(subPath, pakVfs, basePath, config.extractedPath);

        let message = `File not found: ${subPath}`;
        if (suggestions.length > 0) {
          message += "\n\nDid you mean one of these?";
          for (const s of suggestions) {
            message += `\n  ${s}`;
          }
        }
        message += "\n\nTip: Use game_search to find files by name, class, or GUID.";

        return {
          content: [{ type: "text", text: message }],
          isError: true,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error reading game file: ${msg}` }],
        isError: true,
        };
      }
    }
  );
}
