import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

const DEFAULT_EXTENSIONS = [".c", ".et", ".conf", ".layout", ".st"];

// ── File walker ───────────────────────────────────────────────────────────────

interface FileEntry {
  fullPath: string;
  relPath: string;
  content: string;
}

function walkProjectFiles(
  dir: string,
  basePath: string,
  extensions: string[],
): FileEntry[] {
  const results: FileEntry[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(basePath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      results.push(...walkProjectFiles(fullPath, basePath, extensions));
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.size > 1_000_000) continue;
        const content = readFileSync(fullPath, "utf-8");
        results.push({ fullPath, relPath, content });
      } catch {
        // Skip unreadable files
      }
    }
  }

  return results;
}

// ── Replacement tracking ──────────────────────────────────────────────────────

interface Replacement {
  relPath: string;
  line: number;
  before: string;
  after: string;
}

// ── rename_class ──────────────────────────────────────────────────────────────

function renameClass(
  files: FileEntry[],
  oldName: string,
  newName: string,
): { replacements: Replacement[]; fileContents: Map<string, string> } {
  const replacements: Replacement[] = [];
  const fileContents = new Map<string, string>();

  // Build patterns that match oldName in various contexts:
  // 1. Class declarations: "class OLD_NAME" / "modded class OLD_NAME"
  // 2. Parent class: ": OLD_NAME"
  // 3. Type references: "OLD_NAME " / "OLD_NAME." / "OLD_NAME(" / "OLD_NAME;"
  // 4. String references: "OLD_NAME" in quotes
  // 5. Prefixed identifiers: "OLD_NAME" as start of word
  const escaped = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns: RegExp[] = [
    // Class declarations
    new RegExp(`(modded\\s+)?class\\s+${escaped}`, "g"),
    // Parent class (extends)
    new RegExp(`:\\s*${escaped}`, "g"),
    // Type references (word boundary)
    new RegExp(`\\b${escaped}\\b`, "g"),
  ];

  for (const file of files) {
    let content = file.content;
    let changed = false;
    const lines = content.split("\n");
    const seenLines = new Set<number>();

    for (const pattern of patterns) {
      // Reset regex state
      pattern.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.exec(content)) !== null) {
        const offset = match.index;
        const lineNum = content.substring(0, offset).split("\n").length;
        const lineIdx = lineNum - 1;

        if (seenLines.has(lineIdx)) continue;
        seenLines.add(lineIdx);

        const lineText = lines[lineIdx] ?? "";
        const newLine = lineText.split(oldName).join(newName);

        if (newLine !== lineText) {
          replacements.push({
            relPath: file.relPath,
            line: lineNum,
            before: lineText.trim().substring(0, 120),
            after: newLine.trim().substring(0, 120),
          });
          lines[lineIdx] = newLine;
          changed = true;
        }
      }
    }

    if (changed) {
      fileContents.set(file.fullPath, lines.join("\n"));
    }
  }

  return { replacements, fileContents };
}

// ── find_replace ──────────────────────────────────────────────────────────────

function findReplace(
  files: FileEntry[],
  oldName: string,
  newName: string,
  useRegex: boolean,
): { replacements: Replacement[]; fileContents: Map<string, string> } {
  const replacements: Replacement[] = [];
  const fileContents = new Map<string, string>();

  let pattern: RegExp;
  try {
    pattern = useRegex
      ? new RegExp(oldName, "g")
      : new RegExp(oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g");
  } catch (e) {
    throw new Error(`Invalid regex pattern: ${e instanceof Error ? e.message : String(e)}`);
  }

  for (const file of files) {
    if (!pattern.test(file.content)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;

    const lines = file.content.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      const newLine = lines[i].replace(pattern, newName);

      if (newLine !== lines[i]) {
        replacements.push({
          relPath: file.relPath,
          line: i + 1,
          before: lines[i].trim().substring(0, 120),
          after: newLine.trim().substring(0, 120),
        });
        lines[i] = newLine;
        changed = true;
      }
    }

    if (changed) {
      fileContents.set(file.fullPath, lines.join("\n"));
    }
  }

  return { replacements, fileContents };
}

// ── rename_prefix ─────────────────────────────────────────────────────────────

function renamePrefix(
  files: FileEntry[],
  oldPrefix: string,
  newPrefix: string,
): { replacements: Replacement[]; fileContents: Map<string, string> } {
  const replacements: Replacement[] = [];
  const fileContents = new Map<string, string>();

  // Match identifiers that start with oldPrefix followed by a word char or end of identifier
  const escaped = oldPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\b(${escaped}[A-Za-z0-9_]*)`, "g");

  for (const file of files) {
    if (!pattern.test(file.content)) {
      pattern.lastIndex = 0;
      continue;
    }
    pattern.lastIndex = 0;

    const lines = file.content.split("\n");
    let changed = false;

    for (let i = 0; i < lines.length; i++) {
      pattern.lastIndex = 0;
      const newLine = lines[i].replace(pattern, (match) => {
        return newPrefix + match.substring(oldPrefix.length);
      });

      if (newLine !== lines[i]) {
        replacements.push({
          relPath: file.relPath,
          line: i + 1,
          before: lines[i].trim().substring(0, 120),
          after: newLine.trim().substring(0, 120),
        });
        lines[i] = newLine;
        changed = true;
      }
    }

    if (changed) {
      fileContents.set(file.fullPath, lines.join("\n"));
    }
  }

  return { replacements, fileContents };
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildReport(
  action: string,
  oldName: string,
  newName: string,
  replacements: Replacement[],
  dryRun: boolean,
): string {
  const lines: string[] = [];
  const affectedFiles = new Set(replacements.map((r) => r.relPath));

  lines.push(`## Batch: ${action} ${oldName} \u2192 ${newName}`);
  lines.push("");

  if (dryRun) {
    lines.push("### Preview (dry run)");
  } else {
    lines.push("### Changes applied");
  }
  lines.push("");

  if (replacements.length === 0) {
    lines.push("  No matches found.");
  } else {
    for (const r of replacements) {
      lines.push(`  ${r.relPath}:${r.line} \u2014 ${r.before}`);
      lines.push(`    \u2192 ${r.after}`);
    }
  }

  lines.push("");
  lines.push("### Summary");
  lines.push(`- ${affectedFiles.size} file${affectedFiles.size !== 1 ? "s" : ""} affected`);
  lines.push(`- ${replacements.length} replacement${replacements.length !== 1 ? "s" : ""}`);
  lines.push(
    `- Action: ${dryRun ? "dry run (no files modified)" : "applied"}`
  );

  if (dryRun && replacements.length > 0) {
    lines.push("");
    lines.push("To apply: call with dryRun=false");
  }

  return lines.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerProjectBatch(server: McpServer, config: Config): void {
  server.registerTool(
    "project_batch",
    {
      description:
        "Perform batch operations across project files \u2014 rename classes, find-and-replace, or change prefixes. " +
        "Walks all matching files in the mod project and reports all occurrences before applying changes. " +
        "Supports dry-run preview to inspect changes before writing.",
      inputSchema: {
        action: z
          .enum(["rename_class", "find_replace", "rename_prefix"])
          .describe(
            "Operation to perform: " +
            "'rename_class' \u2014 rename a class across all files (handles declarations, references, parent classes, strings), " +
            "'find_replace' \u2014 simple substring/regex find-and-replace across all files, " +
            "'rename_prefix' \u2014 change a class prefix (e.g., OLD_ \u2192 NEW_ renames OLD_Foo to NEW_Foo)."
          ),
        projectPath: z
          .string()
          .describe(
            "Mod project directory to operate on. " +
            "Should be an addon root containing .gproj, Scripts/, UI/, etc."
          ),
        oldName: z
          .string()
          .min(1)
          .describe(
            "Old class name, substring pattern, or prefix to replace. " +
            "For rename_class: the class name (e.g., 'SCR_TraderMenu'). " +
            "For find_replace: the search pattern (substring or regex). " +
            "For rename_prefix: the current prefix (e.g., 'OLD_')."
          ),
        newName: z
          .string()
          .describe(
            "New class name, replacement string, or prefix. " +
            "For rename_class: the new class name (e.g., 'SCR_ShopMenu'). " +
            "For find_replace: the replacement string. " +
            "For rename_prefix: the new prefix (e.g., 'NEW_')."
          ),
        dryRun: z
          .boolean()
          .default(true)
          .describe(
            "Preview changes without writing files (default: true). " +
            "Set to false to actually apply replacements."
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe(
            "File extensions to modify (e.g., ['.c', '.layout']). " +
            "Defaults to ['.c', '.et', '.conf', '.layout', '.st']."
          ),
        useRegex: z
          .boolean()
          .optional()
          .describe(
            "(find_replace only) Treat oldName as a regex pattern instead of a literal string. Default: false."
          ),
      },
    },
    async ({ action, projectPath, oldName, newName, dryRun, extensions, useRegex }) => {
      const basePath = projectPath;

      if (!existsSync(basePath)) {
        return {
          content: [{ type: "text", text: `Project directory not found: ${basePath}` }],
          isError: true,
        };
      }

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

      const searchExts = extensions ?? DEFAULT_EXTENSIONS;

      try {
        const files = walkProjectFiles(basePath, basePath, searchExts);

        let replacements: Replacement[];
        let fileContents: Map<string, string>;

        switch (action) {
          case "rename_class": {
            const result = renameClass(files, oldName, newName);
            replacements = result.replacements;
            fileContents = result.fileContents;
            break;
          }

          case "find_replace": {
            const result = findReplace(files, oldName, newName, useRegex ?? false);
            replacements = result.replacements;
            fileContents = result.fileContents;
            break;
          }

          case "rename_prefix": {
            const result = renamePrefix(files, oldName, newName);
            replacements = result.replacements;
            fileContents = result.fileContents;
            break;
          }

          default: {
            return {
              content: [{ type: "text", text: `Unknown action: ${action}` }],
              isError: true,
            };
          }
        }

        const report = buildReport(action, oldName, newName, replacements, dryRun);

        // Apply changes if not dry run
        if (!dryRun && fileContents.size > 0) {
          for (const [fullPath, content] of fileContents) {
            writeFileSync(fullPath, content, "utf-8");
          }
        }

        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error in batch operation: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
