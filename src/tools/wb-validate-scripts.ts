import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";

interface ValidateIssue {
  error?: string;
  file?: string;
  fileAbs?: string;
  addon?: string;
  line?: number;
}

function renderIssues(label: string, issues: ValidateIssue[], limit: number): string[] {
  if (issues.length === 0) return [];
  const lines = [`\n**${label} (${issues.length}):**`];
  for (const i of issues.slice(0, limit)) {
    const where = [i.file, i.line ? `:${i.line}` : ""].join("");
    const addon = i.addon ? ` (${i.addon})` : "";
    lines.push(`- ${i.error ?? "(no message)"}${where ? ` — ${where}` : ""}${addon}`);
  }
  if (issues.length > limit) lines.push(`- …and ${issues.length - limit} more`);
  return lines;
}

export function registerWbValidateScripts(server: McpServer, client: WorkbenchClient): void {
  server.registerTool("wb_validate_scripts", {
    description:
      "Validate Enforce scripts via Workbench builtin ValidateScripts (no custom handler, no restart). " +
      "Checks a script configuration (WORKBENCH, PC, PLAYSTATION, XBOX) and returns compiler errors " +
      "and warnings with file/line/addon. Use before wb_reload — it does not reload anything and " +
      "cannot trigger the GameApp.cpp:1287 leak assert.",
    inputSchema: {
      configuration: z
        .string()
        .default("WORKBENCH")
        .describe(
          "Script configuration to validate: WORKBENCH, PC, PLAYSTATION, XBOX, etc. (see project settings)"
        ),
      maxIssues: z
        .number()
        .min(1)
        .max(200)
        .default(25)
        .describe("Maximum errors/warnings to list per severity"),
    },
  }, async ({ configuration, maxIssues }) => {
    let res: Record<string, unknown>;
    try {
      res = await client.call<Record<string, unknown>>("ValidateScripts", { Configuration: configuration });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `ValidateScripts could not be called: ${msg}\n\n` +
              `Is Workbench running? Try \`wb_connect\`, then \`wb_diagnose\`.`,
          },
        ],
        isError: true,
      };
    }

    // Verified payload shape (NetApiDocs.c): { Errors: [...], Warnings: [...], Success: bool }.
    // Some builds omit Success, so derive it from the error count.
    const errors = Array.isArray(res.Errors) ? (res.Errors as ValidateIssue[]) : [];
    const warnings = Array.isArray(res.Warnings) ? (res.Warnings as ValidateIssue[]) : [];
    const success = typeof res.Success === "boolean" ? res.Success : errors.length === 0;

    const lines: string[] = [];
    lines.push(`**ValidateScripts — ${configuration}**`);
    lines.push(`- **Result:** ${success ? "PASS" : "FAIL"}`);
    lines.push(`- **Errors:** ${errors.length}`);
    lines.push(`- **Warnings:** ${warnings.length}`);

    lines.push(...renderIssues("Errors", errors, maxIssues));
    lines.push(...renderIssues("Warnings", warnings, maxIssues));

    if (!success) {
      lines.push(
        `\nFix the errors above before \`wb_reload\`. A failed compile leaves the previous scripts loaded.`
      );
    } else if (errors.length === 0 && warnings.length > 0) {
      lines.push(`\nCompiles cleanly — warnings are informational (deprecated APIs, unused vars).`);
    } else {
      lines.push(`\nCompiles cleanly. Safe to run \`wb_reload\` (use the default safe mode).`);
    }

    // Preserve any unexpected fields so nothing is silently dropped.
    const known = new Set(["Errors", "Warnings", "Success"]);
    const extra = Object.entries(res).filter(([k, v]) => !known.has(k) && v !== undefined);
    if (extra.length) {
      lines.push(`\n**Other fields:** ${extra.map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(", ")}`);
    }

    return { content: [{ type: "text" as const, text: lines.join("\n") }], isError: !success };
  });
}
