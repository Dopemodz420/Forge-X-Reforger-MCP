import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

const MAX_FILE_SIZE = 512_000;

const TEXT_EXTENSIONS = new Set([".c", ".layout", ".txt"]);

interface ValidationResults {
  layoutNames: string[];
  scriptRefs: string[];
  missingFromLayout: string[];
  unreferencedInScript: string[];
  unnamedWidgets: number;
}

function extractLayoutNames(content: string): string[] {
  const names: string[] = [];
  const re = /Name\s+"([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    names.push(m[1]);
  }
  return names;
}

function extractScriptRefs(content: string): string[] {
  const refs: string[] = [];
  const re = /Find(?:Any)?Widget\(\s*"([^"]+)"\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    refs.push(m[1]);
  }
  return refs;
}

function countUnnamedWidgets(content: string): number {
  let count = 0;
  const re = /Widget\s*\{/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    count++;
  }
  // Subtract widgets that have a Name attribute
  const namedRe = /Name\s+"[^"]+"/g;
  while ((namedRe.exec(content)) !== null) {
    count--;
  }
  return Math.max(0, count);
}

function readFileSafe(filePath: string): string | null {
  try {
    if (!existsSync(filePath)) return null;
    const stats = statSync(filePath);
    if (stats.isDirectory()) return null;
    const ext = extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) return null;
    if (stats.size > MAX_FILE_SIZE) return null;
    return readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}

function readFileFromProjectOrGame(
  relativePath: string,
  config: Config
): string | null {
  // Try project directory first
  if (config.projectPath) {
    const fullPath = resolve(config.projectPath, relativePath);
    const content = readFileSafe(fullPath);
    if (content !== null) return content;
  }

  // Try game data loose files
  const basePath = resolveGameDataPath(config.gamePath);
  if (basePath) {
    const fullPath = resolve(basePath, relativePath);
    const content = readFileSafe(fullPath);
    if (content !== null) return content;
  }

  // Try pak VFS
  const pakVfs = PakVirtualFS.get(config.gamePath);
  if (pakVfs && pakVfs.exists(relativePath)) {
    const fileSize = pakVfs.fileSize(relativePath);
    if (fileSize <= MAX_FILE_SIZE) {
      return pakVfs.readTextFile(relativePath);
    }
  }

  return null;
}

function formatResults(
  layoutPath: string,
  scriptPath: string,
  results: ValidationResults
): string {
  const lines: string[] = [];
  const layoutName = layoutPath.split(/[\\/]/).pop() ?? layoutPath;

  lines.push(`## Layout Validation: ${layoutName}`);
  lines.push("");

  // Script → Layout references
  lines.push("### Script → Layout References");
  if (results.scriptRefs.length === 0) {
    lines.push("_(no FindAnyWidget/FindWidget calls found in script)_");
  } else {
    for (const ref of results.scriptRefs) {
      if (results.layoutNames.includes(ref)) {
        lines.push(`✅ ${ref} — found in layout`);
      } else {
        lines.push(`❌ ${ref} — NOT FOUND in layout (null-ref risk!)`);
      }
    }
  }
  lines.push("");

  // Layout → Script coverage
  lines.push("### Layout → Script Coverage");
  if (results.layoutNames.length === 0) {
    lines.push("_(no named widgets found in layout)_");
  } else {
    const referencedSet = new Set(results.scriptRefs);
    for (const name of results.layoutNames) {
      if (referencedSet.has(name)) {
        // already reported above
      } else {
        lines.push(`ℹ️ ${name} — in layout but not referenced in script (unused?)`);
      }
    }
  }
  if (results.unnamedWidgets > 0) {
    lines.push(`ℹ️ ${results.unnamedWidgets} unnamed widget(s) in layout`);
  }
  lines.push("");

  // Summary
  lines.push("### Summary");
  const resolved = results.scriptRefs.filter((r) =>
    results.layoutNames.includes(r)
  );
  const missing = results.scriptRefs.filter(
    (r) => !results.layoutNames.includes(r)
  );
  const unreferenced = results.layoutNames.filter(
    (n) => !new Set(results.scriptRefs).has(n)
  );

  lines.push(
    `- ${resolved.length}/${results.scriptRefs.length} script references resolved`
  );
  if (missing.length > 0) {
    lines.push(`- ${missing.length} missing widget(s) (potential crash)`);
  }
  if (results.unnamedWidgets > 0) {
    lines.push(`- ${results.unnamedWidgets} unnamed widget(s)`);
  }
  if (unreferenced.length > 0) {
    lines.push(`- ${unreferenced.length} unreferenced widget(s)`);
  }

  if (missing.length === 0 && results.scriptRefs.length > 0) {
    lines.push("");
    lines.push("✅ All script references resolved — no null-ref risk.");
  }

  return lines.join("\n");
}

export function registerLayoutValidate(server: McpServer, config: Config): void {
  server.registerTool(
    "layout_validate",
    {
      description:
        "Validate that widget names in a .layout file match FindAnyWidget()/FindWidget() calls in a .c script file. " +
        "Catches the #1 bug source in Enfusion UI — null-ref crashes from widget name mismatches. " +
        "Reports missing widgets (error), unnamed widgets (warning), and unreferenced widgets (info).",
      inputSchema: {
        layoutPath: z
          .string()
          .min(1)
          .describe(
            "Relative path to the .layout file (e.g., 'UI/layouts/MyMod/TraderMenu.layout')"
          ),
        scriptPath: z
          .string()
          .min(1)
          .describe(
            "Relative path to the .c script file (e.g., 'scripts/Game/UI/MyMod/SCR_TraderMenu.c')"
          ),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Addon root path. Uses configured default if omitted."
          ),
      },
    },
    async ({ layoutPath, scriptPath, projectPath }) => {
      const basePath = projectPath || config.projectPath;

      // Validate layout path
      if (layoutPath.includes("..")) {
        return {
          content: [
            { type: "text", text: "Path traversal not allowed: '..' segments are blocked" },
          ],
          isError: true,
        };
      }

      // Validate script path
      if (scriptPath.includes("..")) {
        return {
          content: [
            { type: "text", text: "Path traversal not allowed: '..' segments are blocked" },
          ],
          isError: true,
        };
      }

      // Verify extensions
      const layoutExt = extname(layoutPath).toLowerCase();
      if (layoutExt !== ".layout") {
        return {
          content: [
            { type: "text", text: `Expected a .layout file, got: ${layoutExt}` },
          ],
          isError: true,
        };
      }

      const scriptExt = extname(scriptPath).toLowerCase();
      if (scriptExt !== ".c") {
        return {
          content: [
            { type: "text", text: `Expected a .c script file, got: ${scriptExt}` },
          ],
          isError: true,
        };
      }

      // Read layout file
      let layoutContent: string | null = null;

      // Try project directory
      if (basePath) {
        try {
          const fullPath = validateProjectPath(basePath, layoutPath);
          layoutContent = readFileSafe(fullPath);
        } catch {
          // path traversal or other error — skip
        }
      }

      // Try game VFS
      if (layoutContent === null) {
        layoutContent = readFileFromProjectOrGame(layoutPath, config);
      }

      if (layoutContent === null) {
        return {
          content: [
            {
              type: "text",
              text: `Layout file not found: ${layoutPath}\n\nSearched in:\n- Project: ${basePath ?? "(not configured)"}\n- Game data: ${config.gamePath}\n\nTip: Use project_browse or game_search to find the correct path.`,
            },
          ],
          isError: true,
        };
      }

      // Read script file
      let scriptContent: string | null = null;

      if (basePath) {
        try {
          const fullPath = validateProjectPath(basePath, scriptPath);
          scriptContent = readFileSafe(fullPath);
        } catch {
          // path traversal or other error — skip
        }
      }

      if (scriptContent === null) {
        scriptContent = readFileFromProjectOrGame(scriptPath, config);
      }

      if (scriptContent === null) {
        return {
          content: [
            {
              type: "text",
              text: `Script file not found: ${scriptPath}\n\nSearched in:\n- Project: ${basePath ?? "(not configured)"}\n- Game data: ${config.gamePath}\n\nTip: Use project_browse or game_search to find the correct path.`,
            },
          ],
          isError: true,
        };
      }

      // Extract and compare
      const layoutNames = extractLayoutNames(layoutContent);
      const scriptRefs = extractScriptRefs(scriptContent);
      const unnamedWidgets = countUnnamedWidgets(layoutContent);

      const missingFromLayout = scriptRefs.filter(
        (r) => !layoutNames.includes(r)
      );
      const unreferencedInScript = layoutNames.filter(
        (n) => !scriptRefs.includes(n)
      );

      const results: ValidationResults = {
        layoutNames,
        scriptRefs,
        missingFromLayout,
        unreferencedInScript,
        unnamedWidgets,
      };

      const output = formatResults(layoutPath, scriptPath, results);

      // Return as error if there are missing widgets (null-ref risk)
      const hasErrors = missingFromLayout.length > 0;

      return {
        content: [{ type: "text", text: output }],
        isError: hasErrors,
      };
    }
  );
}
