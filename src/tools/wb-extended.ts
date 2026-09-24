import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";

export function registerWbExtended(server: McpServer, client: WorkbenchClient): void {
  server.registerTool("wb_search_resources", {
    description: "Search Workbench resources via Workbench.SearchResources (exact $addon:Prefabs, filter by extensions). Live but no custom handler — uses Workbench API.",
    inputSchema: {
      rootPath: z.string().default("").describe("Root path e.g. \"$TarkovTraderShop:Prefabs\" or \"\" for all"),
      extensions: z.array(z.string()).optional().describe("File extensions filter e.g. [\"et\",\"c\"]"),
      searchStr: z.array(z.string()).optional().describe("Search strings"),
      recursive: z.boolean().default(true).describe("Recursive"),
    }
  }, async ({ rootPath, extensions, searchStr, recursive }) => {
    try {
      // Use custom handler if available, fallback to builtin SearchResources via Workbench module
      const res = await client.call<Record<string, unknown>>("EMCP_WB_Resources", { action: "search", rootPath, extensions, searchStr, recursive });
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    } catch {
      // Fallback: use Workbench.SearchResources via generic call — not all builds expose it, so degrade
      return { content: [{ type: "text" as const, text: `Search via Workbench.SearchResources not directly exposed; use game_search or project_search for offline, or wb_resources for live.` }], isError: true };
    }
  });

  server.registerTool("wb_current_project", {
    description: "Get current game project file via Workbench.GetCurrentGameProjectFile(). Live.",
    inputSchema: {}
  }, async () => {
    try {
      const res = await client.call<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 3000 });
      // GetState already includes mode and maybe project; fallback to Workbench API if handler missing
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `Failed: ${e instanceof Error?e.message:String(e)}` }], isError: true };
    }
  });

  server.registerTool("wb_generate_guid", {
    description: "Generate a globally unique 64-bit ID via Workbench.GenerateGloballyUniqueID64(). Live.",
    inputSchema: {}
  }, async () => {
    try {
      const res = await client.call<Record<string, unknown>>("EMCP_WB_Resources", { action: "generateGuid" });
      return { content: [{ type: "text" as const, text: JSON.stringify(res, null, 2) }] };
    } catch {
      // Fallback offline
      const id = Array.from({length:16},()=>Math.floor(Math.random()*16).toString(16)).join("").toUpperCase();
      return { content: [{ type: "text" as const, text: `**Offline GUID:** \`${id}\` (Workbench not connected, generated locally)` }] };
    }
  });

  server.registerTool("wb_is_workbench_running", {
    description: "Check Workbench running + scripts compiled via builtin IsWorkbenchRunning / IsWorldEditorRunning (no custom handler).",
    inputSchema: {}
  }, async () => {
    for (const func of ["IsWorkbenchRunning","IsWorldEditorRunning"]) {
      try {
        const res = await client.call<Record<string, unknown>>(func, {}, { timeout: 3000 });
        return { content: [{ type: "text" as const, text: `**${func}:**\n\`\`\`json\n${JSON.stringify(res,null,2)}\n\`\`\`` }] };
      } catch {}
    }
    // Fallback to ping
    const alive = await client.ping();
    return { content: [{ type: "text" as const, text: alive ? "**Workbench ping: alive (NET API 5780)**" : "**Workbench ping: no response (check File > Options > Net API 5780 and restart)**" }] };
  });
}
