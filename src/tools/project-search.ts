import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

/** Default extensions to search */
const DEFAULT_EXTENSIONS = [".c", ".et", ".conf", ".layout", ".st"];

// ── Search mode regex patterns ────────────────────────────────────────────────

const CLASS_REGEX = /(?:modded\s+)?class\s+(\w+)/g;
const METHOD_REGEX = /(?:override\s+)?(?:void|bool|int|float|string|[\w]+)\s+(\w+)\s*\(/g;
const FIND_WIDGET_REGEX = /FindAnyWidget\(\s*"([^"]+)"\s*\)/g;
const WIDGET_NAME_REGEX = /Name\s+"([^"]+)"/g;
const STRING_DOUBLE_REGEX = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const STRING_SINGLE_REGEX = /'([^'\\]*(?:\\.[^'\\]*)*)'/g;

// ── Result types ──────────────────────────────────────────────────────────────

interface MatchResult {
  relPath: string;
  line: number;
  context: string;
}

interface ClassResult {
  relPath: string;
  line: number;
  declaration: string;
  isModded: boolean;
}

interface MethodResult {
  relPath: string;
  line: number;
  signature: string;
  isOverride: boolean;
}

interface WidgetResult {
  relPath: string;
  line: number;
  widgetName: string;
}

interface StringResult {
  relPath: string;
  line: number;
  literal: string;
}

// ── File walker ───────────────────────────────────────────────────────────────

function walkProject(
  dir: string,
  basePath: string,
  extensions: string[],
  callback: (filePath: string, relPath: string, content: string) => void
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
      walkProject(fullPath, basePath, extensions, callback);
    } else {
      const ext = extname(entry.name).toLowerCase();
      if (!extensions.includes(ext)) continue;

      try {
        const stat = statSync(fullPath);
        if (stat.size > 1_000_000) continue; // skip files >1MB
        const content = readFileSync(fullPath, "utf-8");
        callback(fullPath, relPath, content);
      } catch {
        // Skip unreadable files
      }
    }
  }
}

// ── Search functions ──────────────────────────────────────────────────────────

function searchClass(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): ClassResult[] {
  const results: ClassResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;
    if (!extensions.includes(extname(filePath).toLowerCase())) return;

    const lines = content.split("\n");
    const regex = new RegExp(CLASS_REGEX.source, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      if (results.length >= limit) break;
      const className = match[1];
      if (!className.toLowerCase().includes(queryLower)) continue;

      const offset = match.index;
      const lineNum = content.substring(0, offset).split("\n").length;
      const lineText = lines[lineNum - 1]?.trim() ?? "";

      results.push({
        relPath,
        line: lineNum,
        declaration: lineText.substring(0, 120),
        isModded: lineText.startsWith("modded"),
      });
    }
  });

  return results;
}

function searchMethod(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): MethodResult[] {
  const results: MethodResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;
    const ext = extname(filePath).toLowerCase();
    if (ext !== ".c") return; // methods only in scripts

    const lines = content.split("\n");
    const regex = new RegExp(METHOD_REGEX.source, "g");
    let match: RegExpExecArray | null;

    while ((match = regex.exec(content)) !== null) {
      if (results.length >= limit) break;
      const methodName = match[1];
      if (!methodName.toLowerCase().includes(queryLower)) continue;

      const offset = match.index;
      const lineNum = content.substring(0, offset).split("\n").length;
      const lineText = lines[lineNum - 1]?.trim() ?? "";

      results.push({
        relPath,
        line: lineNum,
        signature: lineText.substring(0, 120),
        isOverride: lineText.includes("override"),
      });
    }
  });

  return results;
}

function searchWidget(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): WidgetResult[] {
  const results: WidgetResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;

    const lines = content.split("\n");

    // FindAnyWidget("Name") references
    const findRegex = new RegExp(FIND_WIDGET_REGEX.source, "g");
    let match: RegExpExecArray | null;

    while ((match = findRegex.exec(content)) !== null) {
      if (results.length >= limit) break;
      const widgetName = match[1];
      if (!widgetName.toLowerCase().includes(queryLower)) continue;

      const offset = match.index;
      const lineNum = content.substring(0, offset).split("\n").length;

      results.push({ relPath, line: lineNum, widgetName });
    }

    // Widget Name attributes in layouts
    const nameRegex = new RegExp(WIDGET_NAME_REGEX.source, "g");
    while ((match = nameRegex.exec(content)) !== null) {
      if (results.length >= limit) break;
      const widgetName = match[1];
      if (!widgetName.toLowerCase().includes(queryLower)) continue;

      const offset = match.index;
      const lineNum = content.substring(0, offset).split("\n").length;

      // Avoid duplicate entries
      if (!results.some((r) => r.relPath === relPath && r.line === lineNum)) {
        results.push({ relPath, line: lineNum, widgetName });
      }
    }
  });

  return results;
}

function searchReference(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): MatchResult[] {
  const results: MatchResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;
    if (!content.toLowerCase().includes(queryLower)) return;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= limit) break;
      if (lines[i].toLowerCase().includes(queryLower)) {
        results.push({
          relPath,
          line: i + 1,
          context: lines[i].trim().substring(0, 120),
        });
        break; // one match per file
      }
    }
  });

  return results;
}

function searchString(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): StringResult[] {
  const results: StringResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= limit) break;
      const line = lines[i];

      // Double-quoted strings
      const doubleRegex = new RegExp(STRING_DOUBLE_REGEX.source, "g");
      let match: RegExpExecArray | null;
      while ((match = doubleRegex.exec(line)) !== null) {
        if (results.length >= limit) break;
        const literal = match[1];
        if (literal.toLowerCase().includes(queryLower)) {
          results.push({ relPath, line: i + 1, literal: `"${literal}"` });
        }
      }

      // Single-quoted strings
      const singleRegex = new RegExp(STRING_SINGLE_REGEX.source, "g");
      while ((match = singleRegex.exec(line)) !== null) {
        if (results.length >= limit) break;
        const literal = match[1];
        if (literal.toLowerCase().includes(queryLower)) {
          results.push({ relPath, line: i + 1, literal: `'${literal}'` });
        }
      }
    }
  });

  return results;
}

function searchAny(
  basePath: string,
  query: string,
  extensions: string[],
  limit: number
): MatchResult[] {
  const results: MatchResult[] = [];
  const queryLower = query.toLowerCase();

  walkProject(basePath, basePath, extensions, (filePath, relPath, content) => {
    if (results.length >= limit) return;
    if (!content.toLowerCase().includes(queryLower)) return;

    const lines = content.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (results.length >= limit) break;
      if (lines[i].toLowerCase().includes(queryLower)) {
        results.push({
          relPath,
          line: i + 1,
          context: lines[i].trim().substring(0, 120),
        });
      }
    }
  });

  return results;
}

// ── Report builder ────────────────────────────────────────────────────────────

function buildClassReport(query: string, results: ClassResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### Class Definitions (${results.length})`);
  for (const r of results) {
    const tag = r.isModded ? " [modded]" : "";
    lines.push(`  ${r.relPath}:${r.line} — ${r.declaration}${tag}`);
  }
  return lines.join("\n");
}

function buildMethodReport(query: string, results: MethodResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### Method Definitions (${results.length})`);
  for (const r of results) {
    const tag = r.isOverride ? " [override]" : "";
    lines.push(`  ${r.relPath}:${r.line} — ${r.signature}${tag}`);
  }
  return lines.join("\n");
}

function buildWidgetReport(query: string, results: WidgetResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### Widget References (${results.length})`);
  for (const r of results) {
    lines.push(`  ${r.relPath}:${r.line} — ${r.widgetName}`);
  }
  return lines.join("\n");
}

function buildReferenceReport(query: string, results: MatchResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### References (${results.length})`);
  for (const r of results) {
    lines.push(`  ${r.relPath}:${r.line}`);
    lines.push(`    ${r.context}`);
  }
  return lines.join("\n");
}

function buildStringReport(query: string, results: StringResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### String Literals (${results.length})`);
  for (const r of results) {
    lines.push(`  ${r.relPath}:${r.line} — ${r.literal}`);
  }
  return lines.join("\n");
}

function buildAnyReport(query: string, results: MatchResult[]): string {
  const lines: string[] = [];
  lines.push(`## Project Search: "${query}"`);
  lines.push("");
  lines.push(`### Matches (${results.length})`);
  for (const r of results) {
    lines.push(`  ${r.relPath}:${r.line}`);
    lines.push(`    ${r.context}`);
  }
  return lines.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerProjectSearch(server: McpServer, config: Config): void {
  server.registerTool(
    "project_search",
    {
      description:
        "Search within the mod project directory for code patterns — classes, methods, widget references, string literals, or general text. " +
        "Like grep but Enfusion-aware. Searches .c, .et, .conf, .layout, and .st files.",
      inputSchema: {
        query: z
          .string()
          .min(1)
          .describe(
            "Search pattern (substring match, case-insensitive). " +
            "For class: class name like 'SCR_TraderMenu'. " +
            "For method: method name like 'OnMenuOpen'. " +
            "For widget: widget name like 'TitleText'. " +
            "For string: substring to find in string literals. " +
            "For reference/any: arbitrary text to search for."
          ),
        projectPath: z
          .string()
          .describe(
            "Mod project directory to search within. " +
            "Should be an addon root containing .gproj, Scripts/, UI/, etc."
          ),
        type: z
          .enum(["class", "method", "widget", "reference", "string", "any"])
          .default("any")
          .describe(
            "Search mode: " +
            "'class' — find class definitions matching query, " +
            "'method' — find method definitions matching query, " +
            "'widget' — find FindAnyWidget() calls and Name attributes matching query, " +
            "'reference' — find all files containing the query string, " +
            "'string' — find string literals containing the query, " +
            "'any' — search all file contents for the query substring."
          ),
        extensions: z
          .array(z.string())
          .optional()
          .describe(
            "File extensions to search (e.g., ['.c', '.layout']). " +
            "Defaults to ['.c', '.et', '.conf', '.layout', '.st']."
          ),
        limit: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum number of results to return"),
      },
    },
    async ({ query, projectPath, type, extensions, limit }) => {
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

      const searchExts = extensions ?? DEFAULT_EXTENSIONS;

      try {
        let report: string;

        switch (type) {
          case "class": {
            const results = searchClass(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No class definitions found matching "${query}" in ${searchExts.join(", ")} files.`,
                  },
                ],
              };
            }
            report = buildClassReport(query, results);
            break;
          }

          case "method": {
            const results = searchMethod(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No method definitions found matching "${query}" in .c files.`,
                  },
                ],
              };
            }
            report = buildMethodReport(query, results);
            break;
          }

          case "widget": {
            const results = searchWidget(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No widget references found matching "${query}" in ${searchExts.join(", ")} files.`,
                  },
                ],
              };
            }
            report = buildWidgetReport(query, results);
            break;
          }

          case "reference": {
            const results = searchReference(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No references found for "${query}" in ${searchExts.join(", ")} files.`,
                  },
                ],
              };
            }
            report = buildReferenceReport(query, results);
            break;
          }

          case "string": {
            const results = searchString(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No string literals found containing "${query}" in ${searchExts.join(", ")} files.`,
                  },
                ],
              };
            }
            report = buildStringReport(query, results);
            break;
          }

          case "any":
          default: {
            const results = searchAny(basePath, query, searchExts, limit);
            if (results.length === 0) {
              return {
                content: [
                  {
                    type: "text",
                    text: `No matches found for "${query}" in ${searchExts.join(", ")} files.`,
                  },
                ],
              };
            }
            report = buildAnyReport(query, results);
            break;
          }
        }

        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error searching project: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
