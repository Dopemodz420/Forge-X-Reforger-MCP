import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync } from "node:fs";
import { extname } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

export function registerScriptAnalyze(server: McpServer, config: Config): void {
  server.registerTool("script_analyze", {
    description: "Parse a .c Enforce Script file → AST summary: classes, modded classes, methods, attributes, includes. Offline, no Workbench. Goldwep parity (light).",
    inputSchema: {
      path: z.string().describe("File path relative to project root, e.g. Scripts/Game/UI/MyMenu.c"),
      projectPath: z.string().optional().describe("Mod project directory. Uses configured default if omitted."),
    }
  }, async ({ path: inputPath, projectPath }) => {
    const basePath = projectPath || config.projectPath;
    if (!basePath) return { content: [{ type: "text" as const, text: "No project path configured." }], isError: true };
    let full; try { full = validateProjectPath(basePath, inputPath); } catch (e) { return { content: [{ type: "text" as const, text: `Invalid path: ${e instanceof Error?e.message:String(e)}` }], isError: true }; }
    if (!existsSync(full)) return { content: [{ type: "text" as const, text: `File not found: ${inputPath}` }], isError: true };
    if (extname(full).toLowerCase()!==".c") return { content: [{ type: "text" as const, text: "Only .c files supported." }], isError: true };
    const c = readFileSync(full, "utf-8");
    const classes = [...c.matchAll(/(?:modded\s+)?class\s+(\w+)(?:\s*:\s*(\w+))?/g)].map(m=>`${m[0].trim()}`);
    const modded = [...c.matchAll(/modded\s+class\s+(\w+)/g)].map(m=>m[1]);
    const methods = [...c.matchAll(/(?:override\s+)?(?:static\s+)?\w+\s+(\w+)\s*\([^)]*\)\s*(?:\{|;)/g)].map(m=>m[1]).slice(0,50);
    const attrs = [...c.matchAll(/\[Attribute\(/g)].length;
    const includes = [...c.matchAll(/#include\s+"([^"]+)"/g)].map(m=>m[1]);
    const rpc = [...c.matchAll(/\[RPC\]/g)].length;
    const lines = [];
    lines.push(`## ${inputPath}`);
    lines.push(`- **Classes:** ${classes.length? classes.join(", ") : "_(none)_"}`);
    if (modded.length) lines.push(`- **Modded:** ${modded.join(", ")}`);
    lines.push(`- **Methods:** ${methods.length} ${methods.slice(0,10).join(", ")}${methods.length>10?" ...":""}`);
    lines.push(`- **Attributes:** ${attrs} \`[Attribute\` + ${rpc} \`[RPC]\``);
    if (includes.length) lines.push(`- **Includes:** ${includes.join(", ")}`);
    lines.push(`- **Size:** ${c.split("\n").length} lines`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  server.registerTool("script_lint", {
    description: "Lint a .c file for BI Enforce conventions (indentation, naming, modded hygiene). Light regex, offline.",
    inputSchema: {
      path: z.string().describe("File path relative to project root"),
      projectPath: z.string().optional().describe("Mod project directory."),
    }
  }, async ({ path: inputPath, projectPath }) => {
    const basePath = projectPath || config.projectPath;
    if (!basePath) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };
    let full; try { full = validateProjectPath(basePath, inputPath); } catch (e) { return { content: [{ type: "text" as const, text: String(e) }], isError: true }; }
    if (!existsSync(full)) return { content: [{ type: "text" as const, text: `Not found: ${inputPath}` }], isError: true };
    const c = readFileSync(full, "utf-8");
    const issues: string[] = [];
    c.split("\n").forEach((line, i)=>{
      if (/\t/.test(line) && / {2}/.test(line)) issues.push(`${i+1}: mixed tabs+spaces`);
      if (/class\s+[a-z]/.test(line)) issues.push(`${i+1}: class name should be PascalCase`);
      if (/modded\s+class/.test(line) && !/modded class/.test(line)) issues.push(`${i+1}: modded keyword casing`);
      if (line.length>120) issues.push(`${i+1}: line >120 chars`);
    });
    if (!c.endsWith("\n")) issues.push(`EOF: missing final newline`);
    const text = issues.length ? `**Lint ${inputPath}: ${issues.length} issues**\n`+issues.slice(0,50).map(s=>`- ${s}`).join("\n") : `**Lint ${inputPath}: OK — no issues**`;
    return { content: [{ type: "text" as const, text }] };
  });
}
