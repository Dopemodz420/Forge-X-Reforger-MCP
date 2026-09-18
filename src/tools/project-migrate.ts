import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

// ─── Deprecated patterns database ────────────────────────────────────────────

interface DeprecatedPattern {
  deprecated: RegExp;
  replacement: string;
  description: string;
  severity: "error" | "warning" | "info";
}

const DEPRECATED_PATTERNS: DeprecatedPattern[] = [
  {
    deprecated: /GetGame\(\)\.GetWorkspace\(\)\.FindAnyWidget\(/g,
    replacement: "FindAnyWidget(",
    description: "Direct workspace access deprecated, use FindAnyWidget() shortcut",
    severity: "warning",
  },
  {
    deprecated: /GetGame\(\)\.GetWorkspace\(\)\.FindWidget\(/g,
    replacement: "FindWidget(",
    description: "Direct workspace access deprecated, use FindWidget() shortcut",
    severity: "warning",
  },
  {
    deprecated: /GetGame\(\)\.GetWorkspace\(\)\.CreateWidgets\(/g,
    replacement: "CreateWidgets(",
    description: "Direct workspace access deprecated, use CreateWidgets() shortcut",
    severity: "warning",
  },
  {
    deprecated: /m_w\w+\.Remove\(\)/g,
    replacement: "RemoveFromHierarchy()",
    description: "Remove() deprecated, use RemoveFromHierarchy()",
    severity: "error",
  },
  {
    deprecated: /\.Remove\(\);/g,
    replacement: ".RemoveFromHierarchy();",
    description: "Widget Remove() deprecated, use RemoveFromHierarchy()",
    severity: "error",
  },
  {
    deprecated: /GetGame\(\)\.GetInputManager\(\)\.AddActionListener\(/g,
    replacement: "GetGame().GetInputManager().AddActionListener(",
    description: "Verify action listener uses current API signature",
    severity: "info",
  },
  {
    deprecated: /autoptr\s+/g,
    replacement: "ref ",
    description: "autoptr deprecated, use ref or managed instead",
    severity: "warning",
  },
  {
    deprecated: /GetGame\(\)\.GetWorld\(\)\.FindEntityByName\(/g,
    replacement: "GetGame().GetWorld().FindEntityByName(",
    description: "Verify FindEntityByName is still supported, prefer component-based lookup",
    severity: "info",
  },
  {
    deprecated: /SetFlags\s*\(\s*EntityFlags\.GENERATE_MINimap_LOD\s*\)/g,
    replacement: "SetFlags(EntityFlags.GENERATE_MINIMAP_LOD)",
    description: "MINIMAP_LOD flag name may have changed in recent versions",
    severity: "info",
  },
  {
    deprecated: /Math\.RandInt\s*\(/g,
    replacement: "Math.RandomInt(",
    description: "Math.RandInt() deprecated, use Math.RandomInt()",
    severity: "warning",
  },
  {
    deprecated: /Math\.RandFloat\s*\(/g,
    replacement: "Math.RandomFloat(",
    description: "Math.RandFloat() deprecated, use Math.RandomFloat()",
    severity: "warning",
  },
  {
    deprecated: /SCR_GamemodeComponent\.CastFrom\(/g,
    replacement: "SCR_GamemodeComponent.CastFrom(",
    description: "Verify CastFrom usage, prefer direct component access",
    severity: "info",
  },
];

// ─── Result types ────────────────────────────────────────────────────────────

interface Match {
  relPath: string;
  line: number;
  context: string;
  pattern: DeprecatedPattern;
  originalMatch: string;
  lineNumber: number;
}

interface FileScanResult {
  relPath: string;
  matches: Match[];
  modified: boolean;
}

// ─── File walker ─────────────────────────────────────────────────────────────

const SCRIPT_EXTENSIONS = new Set([".c"]);

function walkProject(
  dir: string,
  basePath: string,
  callback: (filePath: string, relPath: string) => void
): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(basePath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      walkProject(fullPath, basePath, callback);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (SCRIPT_EXTENSIONS.has(ext)) {
        callback(fullPath, relPath);
      }
    }
  }
}

// ─── Scan single file ────────────────────────────────────────────────────────

function scanFile(
  filePath: string,
  relPath: string,
  autoFix: boolean
): FileScanResult {
  const result: FileScanResult = { relPath, matches: [], modified: false };

  let content: string;
  try {
    content = readFileSync(filePath, "utf-8");
  } catch {
    return result;
  }

  const lines = content.split("\n");
  let modifiedContent = content;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    for (const pattern of DEPRECATED_PATTERNS) {
      // Reset lastIndex for each pattern since we use global regex
      pattern.deprecated.lastIndex = 0;

      let match: RegExpExecArray | null;
      while ((match = pattern.deprecated.exec(line)) !== null) {
        const lineNum = i + 1;
        const originalLine = line;

        result.matches.push({
          relPath,
          line: lineNum,
          context: line.trim().substring(0, 120),
          pattern,
          originalMatch: match[0],
          lineNumber: lineNum,
        });

        if (autoFix) {
          // Build a fresh regex for replacement (non-global, to avoid lastIndex issues)
          const fixRegex = new RegExp(pattern.deprecated.source, "g");

          let replacement: string;
          if (pattern.deprecated.source.includes("m_w\\w+")) {
            // Special case: remove() → RemoveFromHierarchy()
            // Match any m_w*.Remove() and replace the whole call
            replacement = line.replace(/(m_w\w+)\.Remove\(\)/g, "$1.RemoveFromHierarchy()");
          } else if (pattern.deprecated.source.includes("\\.Remove\\(\\);")) {
            // Generic .Remove(); → .RemoveFromHierarchy();
            replacement = line.replace(/\.Remove\(\);/g, ".RemoveFromHierarchy();");
          } else {
            replacement = line.replace(fixRegex, pattern.replacement);
          }

          if (replacement !== line) {
            modifiedContent = modifiedContent.replace(originalLine, replacement);
            result.modified = true;
          }
        }
      }
    }
  }

  if (autoFix && result.modified) {
    try {
      writeFileSync(filePath, modifiedContent, "utf-8");
    } catch {
      // Write failed — leave modified flag so report shows what would change
    }
  }

  return result;
}

// ─── Report builder ──────────────────────────────────────────────────────────

function buildReport(
  projectPath: string,
  results: FileScanResult[],
  autoFix: boolean
): string {
  const projectName = basename(projectPath);
  const lines: string[] = [];

  const totalMatches = results.reduce((sum, r) => sum + r.matches.length, 0);

  lines.push(`## Migration Report: ${projectName}`);
  lines.push("");

  if (totalMatches === 0) {
    lines.push("### No Deprecated Patterns Found");
    lines.push("");
    lines.push("All `.c` files in this project are using current API patterns.");
    return lines.join("\n");
  }

  lines.push(`### Deprecated Patterns Found (${totalMatches})`);
  lines.push("");

  // Group by file
  for (const result of results) {
    if (result.matches.length === 0) continue;

    lines.push(`${result.relPath}`);
    for (const match of result.matches) {
      const fixTag = autoFix && result.modified ? " (auto-fixed)" : "";
      lines.push(`  Line ${match.line}: ${match.originalMatch}`);
      lines.push(`    → ${match.pattern.replacement}`);
      lines.push(`    Severity: ${match.pattern.severity}${fixTag}`);
      lines.push(`    ${match.pattern.description}`);
      lines.push("");
    }
  }

  // Summary
  const errorCount = results.reduce(
    (sum, r) =>
      sum + r.matches.filter((m) => m.pattern.severity === "error").length,
    0
  );
  const warningCount = results.reduce(
    (sum, r) =>
      sum + r.matches.filter((m) => m.pattern.severity === "warning").length,
    0
  );
  const infoCount = results.reduce(
    (sum, r) =>
      sum + r.matches.filter((m) => m.pattern.severity === "info").length,
    0
  );
  const filesAffected = results.filter((r) => r.matches.length > 0).length;
  const filesFixed = results.filter((r) => r.modified).length;

  lines.push("### Summary");
  if (warningCount > 0) lines.push(`- ${warningCount} warning(s) (deprecated patterns)`);
  if (errorCount > 0) lines.push(`- ${errorCount} error(s) (will break in future versions)`);
  if (infoCount > 0) lines.push(`- ${infoCount} info(s) (verify usage)`);
  lines.push(`- ${totalMatches} total issue(s) across ${filesAffected} file(s)`);

  if (autoFix) {
    lines.push("");
    if (filesFixed > 0) {
      lines.push(`Auto-fix applied: ${filesFixed} file(s) modified`);
    } else {
      lines.push("Auto-fix enabled but no changes were needed or applied");
    }
  } else {
    lines.push("");
    lines.push("To auto-fix: call with autoFix=true");
  }

  return lines.join("\n");
}

// ─── Registration ────────────────────────────────────────────────────────────

export function registerProjectMigrate(server: McpServer, config: Config): void {
  server.registerTool(
    "project_migrate",
    {
      description:
        "Detect deprecated Arma Reforger / Enforce Script API patterns in a mod project and suggest modern replacements. " +
        "Scans all .c files (or a specific file) for known deprecated calls like Remove() → RemoveFromHierarchy(), " +
        "autoptr → ref, direct workspace access shortcuts, and deprecated math functions. " +
        "Can apply fixes automatically when autoFix is enabled.",
      inputSchema: {
        projectPath: z
          .string()
          .describe(
            "Mod project directory to scan. " +
            "Should be an addon root containing Scripts/ with .c files."
          ),
        file: z
          .string()
          .optional()
          .describe(
            "Specific file to check, relative to project root " +
            "(e.g., 'Scripts/Game/UI/Trader/SCR_TraderMenu.c'). " +
            "If omitted, scans all .c files in the project."
          ),
        autoFix: z
          .boolean()
          .default(false)
          .describe(
            "If true, automatically apply fixes to detected deprecated patterns. " +
            "Files will be modified on disk. Default is false (report only)."
          ),
      },
    },
    async ({ projectPath, file, autoFix }) => {
      const basePath = projectPath;

      if (!existsSync(basePath)) {
        return {
          content: [{ type: "text", text: `Project directory not found: ${basePath}` }],
          isError: true,
        };
      }

      // Validate path stays within configured project root
      if (config.projectPath) {
        try {
          validateProjectPath(config.projectPath, projectPath);
        } catch {
          return {
            content: [
              {
                type: "text",
                text: `Invalid project path: "${projectPath}". Path must be within the configured project directory (${config.projectPath}).`,
              },
            ],
            isError: true,
          };
        }
      }

      try {
        const results: FileScanResult[] = [];

        if (file) {
          // Scan a single file
          let targetRelPath = file;
          try {
            validateProjectPath(basePath, file);
          } catch {
            return {
              content: [{ type: "text", text: `Invalid file path: ${file}` }],
              isError: true,
            };
          }

          const fullPath = join(basePath, file);
          if (!existsSync(fullPath)) {
            return {
              content: [{ type: "text", text: `File not found: ${file}` }],
              isError: true,
            };
          }

          const ext = extname(file).toLowerCase();
          if (ext !== ".c") {
            return {
              content: [
                {
                  type: "text",
                  text: `Unsupported file type: ${ext}. Only .c files can be scanned for deprecated patterns.`,
                },
              ],
              isError: true,
            };
          }

          results.push(scanFile(fullPath, targetRelPath, autoFix));
        } else {
          // Scan all .c files in the project
          walkProject(basePath, basePath, (filePath, relPath) => {
            const scanResult = scanFile(filePath, relPath, autoFix);
            if (scanResult.matches.length > 0) {
              results.push(scanResult);
            }
          });

          // Sort by file path for consistent output
          results.sort((a, b) => a.relPath.localeCompare(b.relPath));
        }

        const report = buildReport(basePath, results, autoFix);
        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error during migration scan: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
