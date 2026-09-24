import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";

export function registerWbValidateScripts(server: McpServer, client: WorkbenchClient): void {
  server.registerTool("wb_validate_scripts", {
    description: "Validate Enforce scripts via Workbench builtin ValidateScripts (no custom handler, no restart). Checks WORKBENCH/PC/PLAYSTATION configs and returns compiler errors. Use before wb_reload to catch GameApp.cpp:1287 indirectly.",
    inputSchema: {
      configuration: z.string().default("WORKBENCH").describe("Script configuration to validate: WORKBENCH, PC, PLAYSTATION, XBOX, etc. (see project settings)"),
    }
  }, async ({ configuration }) => {
    try {
      const res = await client.call<Record<string, unknown>>("ValidateScripts", { Configuration: configuration });
      // Builtin returns ScriptsCompiled bool + maybe errors array
      const ok = res.ScriptsCompiled ?? res.scriptsCompiled;
      const text = JSON.stringify(res, null, 2);
      if (ok === true || ok === "true") return { content: [{ type: "text" as const, text: `**ValidateScripts ${configuration}: OK**\n\n\`\`\`json\n${text}\n\`\`\`` }] };
      if (ok === false || ok === "false") return { content: [{ type: "text" as const, text: `**ValidateScripts ${configuration}: FAILED**\n\n\`\`\`json\n${text}\n\`\`\`\n\nFix errors before wb_reload.` }], isError: true };
      return { content: [{ type: "text" as const, text: `**ValidateScripts ${configuration}:**\n\n\`\`\`json\n${text}\n\`\`\`` }] };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { content: [{ type: "text" as const, text: `ValidateScripts failed: ${msg}` }], isError: true };
    }
  });
}
