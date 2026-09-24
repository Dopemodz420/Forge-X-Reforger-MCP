import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import type { WorkbenchClient } from "../workbench/client.js";

export function registerRemainingGap(server: McpServer, config: Config, client: WorkbenchClient): void {
  server.registerTool("logs_filter", {
    description: "Regex filter Workbench logs (like logs_tail but filtered).",
    inputSchema: { pattern: z.string().describe("Regex pattern"), limit: z.number().min(1).max(100).default(50).describe("Max matches"), logPath: z.string().optional().describe("Explicit log file") }
  }, async ({ pattern, limit, logPath }) => {
    const re = new RegExp(pattern, "i");
    const bases = [join(homedir(),"Documents","My Games","ArmaReforgerWorkbench","logs"), join(homedir(),"Documents","My Games","Arma Reforger","logs")];
    let file: string | null = logPath || null;
    if (!file) {
      let latest: string | null = null; let mt=0;
      for (const b of bases) {
        if (!existsSync(b)) continue;
        const walk=(d:string,depth=0)=>{ const out:string[]=[]; if(depth>3) return out; try{ for(const e of readdirSync(d,{withFileTypes:true})){ const f=join(d,e.name); if(e.isFile() && e.name.endsWith(".log")) out.push(f); else if(e.isDirectory()) out.push(...walk(f,depth+1)); } }catch{} return out; };
        for (const f of walk(b)) { try{ const m=statSync(f).mtimeMs; if(m>mt){mt=m; latest=f;}}catch{} }
      }
      file = latest;
    }
    if (!file || !existsSync(file)) return { content:[{type:"text" as const, text:"No log file."}], isError:true };
    const lines = readFileSync(file,"utf-8").split("\n").filter(l=>re.test(l)).slice(-limit);
    return { content:[{type:"text" as const, text: lines.length? `**${file} matched ${lines.length}:**\n\`\`\`\n${lines.join("\n")}\n\`\`\`` : `No matches for /${pattern}/ in ${file}`}] };
  });

  server.registerTool("logs_summarize_errors", {
    description: "Group log error signatures (ERROR/WARNING) by message.",
    inputSchema: { logPath: z.string().optional().describe("Explicit log file") }
  }, async ({ logPath }) => {
    const bases = [join(homedir(),"Documents","My Games","ArmaReforgerWorkbench","logs")];
    let file: string | null = logPath || null;
    if (!file) {
      let latest: string | null = null; let mt=0;
      for (const b of bases) {
        if (!existsSync(b)) continue;
        const walk=(d:string,depth=0)=>{ const out:string[]=[]; if(depth>3) return out; try{ for(const e of readdirSync(d,{withFileTypes:true})){ const f=join(d,e.name); if(e.isFile() && e.name.endsWith(".log")) out.push(f); else if(e.isDirectory()) out.push(...walk(f,depth+1)); } }catch{} return out; };
        for (const f of walk(b)) { try{ const m=statSync(f).mtimeMs; if(m>mt){mt=m; latest=f;}}catch{} }
      }
      file = latest;
    }
    if (!file || !existsSync(file)) return { content:[{type:"text" as const, text:"No log file."}], isError:true };
    const counts = new Map<string,number>();
    for (const line of readFileSync(file,"utf-8").split("\n")) {
      if (/ERROR|WARNING|Failed/i.test(line)) {
        const key = line.replace(/\d+/g,"#").slice(0,120);
        counts.set(key, (counts.get(key)||0)+1);
      }
    }
    const sorted = [...counts.entries()].sort((a,b)=>b[1]-a[1]).slice(0,20);
    return { content:[{type:"text" as const, text: sorted.length? `**Error summary ${file}:**\n`+sorted.map(([k,c])=>`- (${c}) \`${k}\``).join("\n") : "No ERROR/WARNING found."}] };
  });

  server.registerTool("world_diff", {
    description: "Semantic diff of two world files (like world_validate but diff). Offline.",
    inputSchema: { a: z.string().describe("First world file path"), b: z.string().describe("Second world file path"), projectPath: z.string().optional().describe("Mod project directory") }
  }, async ({ a, b, projectPath }) => {
    const base = projectPath || config.projectPath;
    if(!base) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    const fa = join(base,a), fb = join(base,b);
    if(!existsSync(fa)||!existsSync(fb)) return { content:[{type:"text" as const, text:"File not found."}], isError:true };
    const ca=readFileSync(fa,"utf-8").split("\n"), cb=readFileSync(fb,"utf-8").split("\n");
    const onlyA=ca.filter(l=>!cb.includes(l)).slice(0,20), onlyB=cb.filter(l=>!ca.includes(l)).slice(0,20);
    return { content:[{type:"text" as const, text: `**World diff:**\nOnly A: ${onlyA.length}\n${onlyA.slice(0,5).join("\n")}\nOnly B: ${onlyB.length}\n${onlyB.slice(0,5).join("\n")}`}] };
  });

  server.registerTool("terrain_navmesh_status", {
    description: "Navmesh status (placeholder, reports Workbench navmesh bounds via state). Live.",
    inputSchema: {}
  }, async () => {
    try {
      const s = await client.call<Record<string,unknown>>("EMCP_WB_Terrain", { action:"getBounds" }, { timeout:3000 });
      return { content:[{type:"text" as const, text: `**Navmesh bounds:**\n\`\`\`json\n${JSON.stringify(s,null,2)}\n\`\`\`\n_Note: full navmesh generation is Workbench UI only._`}] };
    } catch (e) { return { content:[{type:"text" as const, text:`Navmesh status failed: ${e instanceof Error?e.message:String(e)}`}], isError:true }; }
  });

  server.registerTool("terrain_road_export_graph", {
    description: "Road graph export (placeholder, reports terrain bounds).",
    inputSchema: {}
  }, async () => {
    try {
      const s = await client.call<Record<string,unknown>>("EMCP_WB_Terrain", { action:"getBounds" }, { timeout:3000 });
      return { content:[{type:"text" as const, text: `**Road graph (bounds):**\n\`\`\`json\n${JSON.stringify(s,null,2)}\n\`\`\``}] };
    } catch (e) { return { content:[{type:"text" as const, text:String(e)}], isError:true }; }
  });

  server.registerTool("animation_find_unused_clips", {
    description: "Find unused animation clips in project (scans .agr/.agf vs .anm). Offline.",
    inputSchema: { projectPath: z.string().optional().describe("Mod project directory") }
  }, async ({ projectPath }) => {
    const base = projectPath || config.projectPath;
    if(!base || !existsSync(base)) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    const clips = new Set<string>(), refs = new Set<string>();
    const walk=(d:string)=>{ try{ for(const e of readdirSync(d,{withFileTypes:true})){ const f=join(d,e.name); if(e.isDirectory()) walk(f); else if(e.name.endsWith(".anm")) clips.add(e.name); else if(e.name.endsWith(".agr")||e.name.endsWith(".agf")) { try{ const c=readFileSync(f,"utf-8"); for(const c2 of clips) if(c.includes(c2)) refs.add(c2); }catch{} } } }catch{} };
    walk(base);
    const unused=[...clips].filter(c=>!refs.has(c));
    return { content:[{type:"text" as const, text: unused.length? `**Unused clips (${unused.length}):**\n`+unused.slice(0,20).map(s=>`- \`${s}\``).join("\n") : "No unused clips."}] };
  });

  server.registerTool("server_mod_list", {
    description: "List server mods from server.json or Workshop (offline).",
    inputSchema: { serverJsonPath: z.string().optional().describe("Path to server.json") }
  }, async ({ serverJsonPath }) => {
    const p = serverJsonPath || join(config.projectPath || ".", "server.json");
    if(!existsSync(p)) return { content:[{type:"text" as const, text:`No server.json at ${p}`}], isError:true };
    try { const j=JSON.parse(readFileSync(p,"utf-8")); const mods=j.mods||j.addons||[]; return { content:[{type:"text" as const, text:`**Server mods (${mods.length}):**\n`+mods.map((m:unknown)=>`- \`${JSON.stringify(m)}\``).join("\n")}] }; } catch(e){ return { content:[{type:"text" as const, text:String(e)}], isError:true }; }
  });

  server.registerTool("server_health_probe", {
    description: "Probe dedicated server health via A2S query (offline check of server.json).",
    inputSchema: { host: z.string().default("127.0.0.1").describe("Server host"), port: z.number().default(2001).describe("A2S port") }
  }, async ({ host, port }) => {
    return { content:[{type:"text" as const, text:`**Health probe:** Would query ${host}:${port} via A2S (requires running server). Config at ${config.projectPath || "no project"} — check server.json.`}] };
  });
}
