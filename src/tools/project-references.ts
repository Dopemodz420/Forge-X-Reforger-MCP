import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface Reference {
  /** Relative file path from project root */
  path: string;
  /** Line number (1-based) */
  line: number;
  /** Trimmed line content (max 120 chars) */
  context: string;
  /** Kind of reference detected */
  kind: string;
}

interface OutgoingDep {
  /** Category label */
  kind: string;
  /** Referenced symbol or path */
  target: string;
}

interface AnalysisResult {
  incoming: Reference[];
  outgoing: OutgoingDep[];
  classNames: string[];
  fileGuid: string | null;
}

// ─── File analysis ───────────────────────────────────────────────────────────

function extractClassNames(content: string): string[] {
  const classes: string[] = [];
  const regex = /(?:modded\s+)?class\s+(\w+)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    classes.push(match[1]);
  }
  return classes;
}

function extractFileGuid(content: string): string | null {
  // For .et files, the GUID is often in the first few lines or as a standalone ref
  const guidMatch = content.match(/\b([0-9A-Fa-f]{16})\b/);
  return guidMatch ? guidMatch[1].toUpperCase() : null;
}

function analyzeOutgoing(content: string, ext: string): OutgoingDep[] {
  const deps: OutgoingDep[] = [];
  const seen = new Set<string>();

  function add(kind: string, target: string) {
    const key = `${kind}:${target}`;
    if (seen.has(key)) return;
    seen.add(key);
    deps.push({ kind, target });
  }

  if (ext === ".c") {
    // Parent class references
    const classRegex = /(?:modded\s+)?class\s+\w+\s*:\s*(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = classRegex.exec(content)) !== null) {
      add("Parent class", m[1]);
    }

    // Include/import statements
    const incRegex = /#include\s+"([^"]+)"/g;
    while ((m = incRegex.exec(content)) !== null) {
      add("Include", m[1]);
    }

    // GUID references (resource refs)
    const guidRegex = /\{([0-9A-Fa-f]{16})\}\s*([^\s"{}()]*(?:\.et|\.layout|\.conf|\.imageset|\.edds|\.fnt|\.emat))?/g;
    while ((m = guidRegex.exec(content)) !== null) {
      const path = m[2];
      if (path) {
        add("Resource ref", `{${m[1]}}${path}`);
      } else {
        add("GUID ref", `{${m[1]}}`);
      }
    }

    // Type references (capitalized identifiers used as types)
    const typeRegex = /\b([A-Z][A-Za-z0-9_]+(?:Component|Manager|Menu|Handler|Data|Config|Info|Event|Action|Entity|Base|Script))\b/g;
    while ((m = typeRegex.exec(content)) !== null) {
      add("Type ref", m[1]);
    }

    // Variable declarations with types
    const varRegex = /\b(?:ref\s+|autoptr\s+)?([A-Z][A-Za-z0-9_]+)\s+(?:m_\w+|_[a-z]\w*)\b/g;
    while ((m = varRegex.exec(content)) !== null) {
      add("Variable type", m[1]);
    }
  } else if (ext === ".et") {
    // Parent prefab reference
    const parentRegex = /Parent\s+\{?([0-9A-Fa-f]{16})\}?\s*([^\s"]+\.et)?/gi;
    let m: RegExpExecArray | null;
    while ((m = parentRegex.exec(content)) !== null) {
      const path = m[2];
      add("Parent prefab", path ? `{${m[1]}}${path}` : `{${m[1]}}`);
    }

    // Component type names
    const compRegex = /\b([A-Z][A-Za-z0-9_]+Component)\b/g;
    while ((m = compRegex.exec(content)) !== null) {
      add("Component", m[1]);
    }

    // Resource GUID references
    const guidRegex = /\{([0-9A-Fa-f]{16})\}\s*([^\s"{}]+\.(?:xob|et|layout|conf|edds|emat|fnt|imageset))/g;
    while ((m = guidRegex.exec(content)) !== null) {
      add("Resource ref", `{${m[1]}}${m[2]}`);
    }
  } else if (ext === ".conf") {
    // Root type / class references
    let m: RegExpExecArray | null;

    // Config node types (capitalized first letter, not inside quotes necessarily)
    const typeRegex = /\b([A-Z][A-Za-z0-9_]+(?:Component|Manager|Menu|Handler|Data|Config|Info|Event|Action|Entity|Base|Framework|Campaign|Header|Seizing|Patrol))\b/g;
    while ((m = typeRegex.exec(content)) !== null) {
      add("Type ref", m[1]);
    }

    // Resource path references
    const resRegex = /"\{([0-9A-Fa-f]{16})\}\s*([^\s"]+)"/g;
    while ((m = resRegex.exec(content)) !== null) {
      add("Resource ref", `{${m[1]}}${m[2]}`);
    }
  } else if (ext === ".layout") {
    // Parent layout reference
    let m: RegExpExecArray | null;
    const parentRegex = /Parent\s*=\s*"\{?([0-9A-Fa-f]{16})\}?\s*([^\s"]+\.layout)?/g;
    while ((m = parentRegex.exec(content)) !== null) {
      const path = m[2];
      if (path) {
        add("Parent layout", `{${m[1]}}${path}`);
      }
    }

    // Script handler class names
    const scriptRegex = /Script\s*=\s*"(\w+)"/g;
    while ((m = scriptRegex.exec(content)) !== null) {
      add("Script handler", m[1]);
    }

    // GUID references
    const guidRegex = /\{([0-9A-Fa-f]{16})\}\s*([^\s"{}]+\.(?:layout|imageset|edds|fnt|emat))/g;
    while ((m = guidRegex.exec(content)) !== null) {
      add("Resource ref", `{${m[1]}}${m[2]}`);
    }
  }

  return deps;
}

// ─── Project file walking ────────────────────────────────────────────────────

const SEARCHABLE_EXTENSIONS = new Set([".c", ".et", ".conf", ".layout"]);

function walkProject(
  dir: string,
  callback: (filePath: string, relPath: string) => void,
  baseDir?: string
) {
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
      walkProject(fullPath, callback, base);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (SEARCHABLE_EXTENSIONS.has(ext)) {
        const relPath = relative(base, fullPath).replace(/\\/g, "/");
        callback(fullPath, relPath);
      }
    }
  }
}

// ─── Incoming analysis (scan project for references to target) ────────────────

function findIncomingReferences(
  projectPath: string,
  targetRelPath: string,
  targetClasses: string[],
  targetGuid: string | null
): Reference[] {
  const results: Reference[] = [];
  const targetFileLower = targetRelPath.toLowerCase();
  const targetBaseName = basename(targetRelPath).replace(/\.[^.]+$/, "").toLowerCase();
  const targetClassSet = new Set(targetClasses.map((c) => c.toLowerCase()));

  walkProject(projectPath, (filePath, relPath) => {
    // Don't reference yourself
    if (relPath.toLowerCase() === targetFileLower) return;

    try {
      const content = readFileSync(filePath, "utf-8");
      const lines = content.split("\n");

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const lineLower = line.toLowerCase();
        let matched = false;
        let kind = "";

        // 1. Check for class name references (imported type, variable type, cast target)
        for (const cls of targetClassSet) {
          if (lineLower.includes(cls)) {
            matched = true;
            kind = `class ref: ${targetClasses[targetClassSet.size > 0 ? [...targetClassSet].indexOf(cls) : 0]}`;
            break;
          }
        }

        // 2. Check for file path string references
        if (!matched && lineLower.includes(targetBaseName)) {
          matched = true;
          kind = "name ref";
        }

        // 3. Check for GUID references (if target has a known GUID)
        if (!matched && targetGuid) {
          const guidLower = targetGuid.toLowerCase();
          if (lineLower.includes(guidLower)) {
            matched = true;
            kind = "GUID ref";
          }
        }

        // 4. Check for full relative path string
        if (!matched && line.includes(targetRelPath)) {
          matched = true;
          kind = "path ref";
        }

        if (matched) {
          results.push({
            path: relPath,
            line: i + 1,
            context: line.trim().substring(0, 120),
            kind,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  });

  return results;
}

// ─── Main analysis function ──────────────────────────────────────────────────

function analyzeFile(
  projectPath: string,
  targetPath: string
): AnalysisResult | null {
  const fullPath = validateProjectPath(projectPath, targetPath);

  if (!existsSync(fullPath)) {
    return null;
  }

  const content = readFileSync(fullPath, "utf-8");
  const ext = extname(targetPath).toLowerCase().slice(1);

  const classNames = extractClassNames(content);
  const fileGuid = ext === "et" ? extractFileGuid(content) : null;
  const outgoing = analyzeOutgoing(content, ext);
  const incoming = findIncomingReferences(projectPath, targetPath, classNames, fileGuid);

  return { incoming, outgoing, classNames, fileGuid };
}

// ─── Register tool ───────────────────────────────────────────────────────────

export function registerProjectReferences(server: McpServer, config: Config): void {
  server.registerTool(
    "project_references",
    {
      description:
        "Find dependency relationships for a file in an Arma Reforger mod project. " +
        "Shows what references a file (incoming) and what a file depends on (outgoing). " +
        "Critical for safe refactoring — know what breaks before you change it. " +
        "Scans .c, .et, .conf, and .layout files for class names, GUIDs, resource paths, and type references.",
      inputSchema: {
        path: z
          .string()
          .describe(
            "File path to analyze, relative to the project root " +
            "(e.g., 'Scripts/Game/UI/Trader/SCR_TraderMenu.c', 'Prefabs/UI/TraderMenu.et')"
          ),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Mod project directory. Uses configured default if omitted."
          ),
        mode: z
          .enum(["incoming", "outgoing", "both"])
          .default("both")
          .describe(
            "Analysis mode: 'incoming' finds files that reference this file, " +
            "'outgoing' finds what this file depends on, 'both' runs both directions."
          ),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum results per direction"),
      },
    },
    async ({ path: inputPath, projectPath, mode, limit }) => {
      const basePath = projectPath || config.projectPath;

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(basePath)) {
        return {
          content: [
            {
              type: "text",
              text: `Project directory not found: ${basePath}`,
            },
          ],
          isError: true,
        };
      }

      let targetPath: string;
      try {
        targetPath = validateProjectPath(basePath, inputPath);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Invalid path: ${msg}` }],
          isError: true,
        };
      }

      if (!existsSync(targetPath)) {
        return {
          content: [
            {
              type: "text",
              text: `File not found: ${inputPath}\nResolved to: ${targetPath}`,
            },
          ],
          isError: true,
        };
      }

      const result = analyzeFile(basePath, inputPath);
      if (!result) {
        return {
          content: [{ type: "text", text: `Could not analyze file: ${inputPath}` }],
          isError: true,
        };
      }

      // ── Build output ──────────────────────────────────────────────────

      const lines: string[] = [];
      lines.push(`## References: ${inputPath}`);

      if (result.classNames.length > 0) {
        lines.push("");
        lines.push(`**Defined classes:** ${result.classNames.join(", ")}`);
      }
      if (result.fileGuid) {
        lines.push(`**GUID:** {${result.fileGuid}}`);
      }

      // Incoming
      if (mode === "incoming" || mode === "both") {
        const shown = result.incoming.slice(0, limit);
        lines.push("");
        lines.push(`### Incoming (${result.incoming.length} file${result.incoming.length !== 1 ? "s" : ""} reference this)`);
        if (shown.length === 0) {
          lines.push("  _(no incoming references found)_");
        } else {
          // Group by file
          const byFile = new Map<string, Reference[]>();
          for (const ref of shown) {
            const list = byFile.get(ref.path) || [];
            list.push(ref);
            byFile.set(ref.path, list);
          }
          for (const [filePath, refs] of byFile) {
            for (const ref of refs) {
              lines.push(`  ${filePath}:${ref.line} — ${ref.context}`);
            }
          }
          if (result.incoming.length > limit) {
            lines.push(`\n  ... and ${result.incoming.length - limit} more`);
          }
        }
      }

      // Outgoing
      if (mode === "outgoing" || mode === "both") {
        const shown = result.outgoing.slice(0, limit);
        lines.push("");
        lines.push(`### Outgoing (${result.outgoing.length} dependenc${result.outgoing.length !== 1 ? "ies" : "y"})`);
        if (shown.length === 0) {
          lines.push("  _(no outgoing dependencies found)_");
        } else {
          // Group by kind
          const byKind = new Map<string, OutgoingDep[]>();
          for (const dep of shown) {
            const list = byKind.get(dep.kind) || [];
            list.push(dep);
            byKind.set(dep.kind, list);
          }
          for (const [kind, deps] of byKind) {
            lines.push(`  **${kind}:**`);
            for (const dep of deps) {
              lines.push(`    ${dep.target}`);
            }
          }
          if (result.outgoing.length > limit) {
            lines.push(`\n  ... and ${result.outgoing.length - limit} more`);
          }
        }
      }

      // Summary
      lines.push("");
      lines.push("### Summary");
      lines.push(`- ${result.incoming.length} incoming reference${result.incoming.length !== 1 ? "s" : ""}`);
      lines.push(`- ${result.outgoing.length} outgoing dependenc${result.outgoing.length !== 1 ? "ies" : "y"}`);

      if (mode === "both" && result.incoming.length === 0 && result.outgoing.length === 0) {
        lines.push("");
        lines.push("_This file appears to be isolated — no references found in either direction._");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}
