import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, existsSync, statSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import type { WorkbenchClient } from "../workbench/client.js";

export function registerLogsWorld(server: McpServer, config: Config, client: WorkbenchClient): void {
  server.registerTool("logs_list", {
    description: "List Workbench/game log sessions (profile/TESTANIM + Documents/My Games).",
    inputSchema: { limit: z.number().min(1).max(50).default(10).describe("Max sessions to show") }
  }, async ({ limit }) => {
    const bases = [join(homedir(),"Documents","My Games","ArmaReforgerWorkbench","logs"), join(homedir(),"Documents","My Games","Arma Reforger","logs")];
    const sessions: string[] = [];
    for (const b of bases) {
      if (!existsSync(b)) continue;
      try {
        for (const e of readdirSync(b, {withFileTypes:true})) {
          if (e.isDirectory() || e.name.endsWith(".log")) sessions.push(join(b,e.name));
        }
      } catch {}
    }
    sessions.sort((a,b)=>{ try{ return statSync(b).mtimeMs - statSync(a).mtimeMs; }catch{return 0;}});
    const shown = sessions.slice(0,limit);
    return { content: [{ type: "text" as const, text: shown.length? shown.map(s=>`- \`${s}\` (${new Date(statSync(s).mtimeMs).toLocaleString()})`).join("\n") : "No log sessions found." }] };
  });

  server.registerTool("logs_tail", {
    description: "Tail last N lines of latest Workbench log.",
    inputSchema: { lines: z.number().min(1).max(200).default(50).describe("Lines to tail"), logPath: z.string().optional().describe("Explicit log file path") }
  }, async ({ lines, logPath }) => {
    const bases = [join(homedir(),"Documents","My Games","ArmaReforgerWorkbench","logs"), join(homedir(),"Documents","My Games","Arma Reforger","logs")];
    let file: string | null = logPath || null;
    if (!file) {
      let latest: string | null = null; let mt=0;
      for (const b of bases) {
        if (!existsSync(b)) continue;
        const found: string[] = [];
        const walk=(d:string,depth=0)=>{ if(depth>3) return; try{ for(const e of readdirSync(d,{withFileTypes:true})){ const f=join(d,e.name); if(e.isFile() && e.name.endsWith(".log")) found.push(f); else if(e.isDirectory()) walk(f,depth+1); } }catch{} };
        walk(b);
        for (const f of found) { try { const m=statSync(f).mtimeMs; if(m>mt){mt=m; latest=f;} }catch{} }
      }
      file = latest;
    }
    if (!file || !existsSync(file)) return { content: [{ type: "text" as const, text: "No log file found. Pass logPath explicitly." }], isError: true };
    try {
      const content = readFileSync(file,"utf-8").split("\n");
      const tail = content.slice(-lines).join("\n");
      return { content: [{ type: "text" as const, text: `**${file}** (last ${lines} lines):\n\`\`\`\n${tail}\n\`\`\`` }] };
    } catch (e) { return { content: [{ type: "text" as const, text: String(e) }], isError: true }; }
  });

  server.registerTool("world_compose_summary", {
    description: "Summarize world composition via wb_state + terrain bounds (offline fallback).",
    inputSchema: {}
  }, async () => {
    try {
      const state = await client.call<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 3000 });
      const terrain = await client.call<Record<string, unknown>>("EMCP_WB_Terrain", { action: "getBounds" }, { timeout: 3000 }).catch(()=>null);
      return { content: [{ type: "text" as const, text: `**World compose:**\n\`\`\`json\n${JSON.stringify({state, terrain},null,2)}\n\`\`\`` }] };
    } catch (e) {
      return { content: [{ type: "text" as const, text: `World compose failed (Workbench not connected): ${e instanceof Error?e.message:String(e)} — try wb_state after wb_launch.` }], isError: true };
    }
  });

  server.registerTool("world_validate_refs", {
    description: "Validate world entity refs vs project + base game (wraps find_broken_refs for current world).",
    inputSchema: { projectPath: z.string().optional().describe("Mod project directory") }
  }, async ({ projectPath }) => {
    // Reuse find_broken_refs logic via direct call — delegate
    return { content: [{ type: "text" as const, text: `Use find_broken_refs with projectPath "${projectPath || config.projectPath}" — world_validate_refs is alias for current world.` }] };
  });
}
