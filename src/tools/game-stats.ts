import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, extname } from "node:path";
import type { Config } from "../config.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { ExportVirtualFS } from "../pak/export-vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

export function registerGameStats(server: McpServer, config: Config): void {
  server.registerTool(
    "game_stats",
    {
      description:
        "Show diagnostic information about indexed game data: file counts by type, pak files loaded, " +
        "extracted library status, VFS index size. Use this to debug why files can't be found.",
      inputSchema: {},
    },
    async () => {
      const lines: string[] = [];
      lines.push("## Game Data Statistics\n");

      // Game path
      lines.push(`**Game path:** ${config.gamePath}`);
      const gameExists = existsSync(config.gamePath);
      lines.push(`**Game installed:** ${gameExists ? "Yes" : "No"}`);

      // Extracted path
      if (config.extractedPath) {
        const extractedExists = existsSync(config.extractedPath);
        lines.push(`**Extracted library:** ${config.extractedPath}`);
        lines.push(`**Extracted exists:** ${extractedExists ? "Yes" : "No"}`);
        if (extractedExists) {
          const extractedCount = countFiles(config.extractedPath);
          lines.push(`**Extracted files:** ${extractedCount}`);
        }
      } else {
        lines.push(`**Extracted library:** Not set (set ENFUSION_EXTRACTED_PATH to enable)`);
      }

      // Export path
      if (config.exportPath) {
        const exportExists = existsSync(config.exportPath);
        lines.push(`**Export directory:** ${config.exportPath}`);
        lines.push(`**Export exists:** ${exportExists ? "Yes" : "No"}`);
        if (exportExists) {
          try {
            const exportVfs = ExportVirtualFS.get(config.exportPath);
            if (exportVfs) {
              lines.push(`**Export files indexed:** ${exportVfs.fileCount}`);
            }
          } catch {
            lines.push(`**Export status:** Failed to index`);
          }
        }
      } else {
        lines.push(`**Export directory:** Not set (set ENFUSION_EXPORT_PATH to enable)`);
      }

      lines.push("");

      // Pak files
      const addonsPath = join(config.gamePath, "addons");
      if (existsSync(addonsPath)) {
        const pakFiles = findPakFiles(addonsPath);
        lines.push(`### PAK Files (${pakFiles.length})`);
        let totalPakSize = 0;
        for (const pf of pakFiles) {
          const size = statSync(pf.fullPath).size;
          totalPakSize += size;
          lines.push(`  ${pf.relativePath} — ${(size / 1024 / 1024).toFixed(0)} MB`);
        }
        lines.push(`  **Total:** ${(totalPakSize / 1024 / 1024 / 1024).toFixed(1)} GB`);
        lines.push("");
      }

      // VFS index
      try {
        const pakVfs = PakVirtualFS.get(config.gamePath);
        if (pakVfs) {
          lines.push(`### VFS Index`);
          lines.push(`**Pak files indexed:** ${pakVfs.fileCount}`);

          // Check export VFS
          if (config.exportPath && existsSync(config.exportPath)) {
            try {
              const exportVfs = ExportVirtualFS.get(config.exportPath);
              if (exportVfs) {
                lines.push(`**Export files indexed:** ${exportVfs.fileCount}`);
                lines.push(`**Combined unique files:** ~${pakVfs.fileCount + exportVfs.fileCount}`);
              }
            } catch {
              // Skip
            }
          }

          // Get breakdown by extension
          const allPaths = pakVfs.allFilePaths();
          const extCounts = new Map<string, number>();
          for (const p of allPaths) {
            const ext = extname(p).toLowerCase() || "(none)";
            extCounts.set(ext, (extCounts.get(ext) ?? 0) + 1);
          }

          // Sort by count descending
          const sorted = Array.from(extCounts.entries()).sort((a, b) => b[1] - a[1]);
          lines.push("");
          lines.push("#### By Extension:");
          for (const [ext, count] of sorted.slice(0, 15)) {
            const bar = "█".repeat(Math.min(30, Math.round(count / sorted[0][1] * 30)));
            lines.push(`  ${ext.padEnd(12)} ${String(count).padStart(6)}  ${bar}`);
          }
          if (sorted.length > 15) {
            const rest = sorted.slice(15).reduce((sum, [, c]) => sum + c, 0);
            lines.push(`  ${"(other)".padEnd(12)} ${String(rest).padStart(6)}`);
          }

          // Breakdown by top-level directory
          lines.push("");
          lines.push("#### By Directory:");
          const dirCounts = new Map<string, number>();
          for (const p of allPaths) {
            const topDir = p.split("/")[0] ?? "(root)";
            dirCounts.set(topDir, (dirCounts.get(topDir) ?? 0) + 1);
          }
          const sortedDirs = Array.from(dirCounts.entries()).sort((a, b) => b[1] - a[1]);
          for (const [dir, count] of sortedDirs.slice(0, 15)) {
            const bar = "█".repeat(Math.min(30, Math.round(count / sortedDirs[0][1] * 30)));
            lines.push(`  ${dir.padEnd(20)} ${String(count).padStart(6)}  ${bar}`);
          }

          lines.push("");
        } else {
          lines.push(`### VFS Index`);
          lines.push(`**Status:** Not initialized (no pak files found)`);
          lines.push("");
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lines.push(`### VFS Index`);
        lines.push(`**Error:** ${msg}`);
        lines.push("");
      }

      // Loose files
      const basePath = resolveGameDataPath(config.gamePath);
      if (basePath && existsSync(basePath)) {
        lines.push(`### Loose Files`);
        lines.push(`**Path:** ${basePath}`);
        const looseCount = countFiles(basePath);
        lines.push(`**Files:** ${looseCount}`);
        lines.push("");
      }

      // Search suggestion
      lines.push(`### Tips`);
      lines.push(`- Use \`game_search\` to find files by name, class, or GUID`);
      lines.push(`- Use \`game_read\` to read file contents`);
      lines.push(`- Use \`game_browse\` to list directory contents`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function findPakFiles(dir: string): Array<{ fullPath: string; relativePath: string }> {
  const results: Array<{ fullPath: string; relativePath: string }> = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }
  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isFile() && extname(entry.name).toLowerCase() === ".pak") {
      results.push({ fullPath, relativePath: fullPath.replace(/^.*[\\/]addons[\\/]/, "addons/") });
    } else if (entry.isDirectory()) {
      results.push(...findPakFiles(fullPath));
    }
  }
  return results;
}

function countFiles(dir: string): number {
  let count = 0;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const entry of entries) {
    if (entry.isFile()) {
      count++;
    } else if (entry.isDirectory()) {
      count += countFiles(join(dir, entry.name));
    }
  }
  return count;
}
