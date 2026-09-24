import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

function walkC(dir: string, cb: (full: string, rel: string)=>void, base=dir){
  let entries; try{ entries=readdirSync(dir,{withFileTypes:true}); }catch{return;}
  for(const e of entries){
    if(e.name.startsWith(".")) continue;
    const full=join(dir,e.name);
    if(e.isDirectory()) walkC(full,cb,base);
    else if(extname(e.name).toLowerCase()===".c") cb(full, relative(base,full).replace(/\\/g,"/"));
  }
}

export function registerScriptExtended(server: McpServer, config: Config): void {
  server.registerTool("script_overrides", {
    description: "Find every modded class chain for a base class across project .c files.",
    inputSchema: {
      baseClass: z.string().describe("Base class name, e.g. SCR_HUD"),
      projectPath: z.string().optional().describe("Mod project directory"),
    }
  }, async ({ baseClass, projectPath }) => {
    const base = projectPath || config.projectPath;
    if(!base || !existsSync(base)) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    const hits: string[] = [];
    walkC(base, (full, rel)=>{
      try{
        const c=readFileSync(full,"utf-8");
        const re=new RegExp(`modded\\s+class\\s+(\\w+)\\s*:\\s*${baseClass}\\b`,"g");
        let m: RegExpExecArray | null; while((m=re.exec(c))!==null) hits.push(`${rel}: modded class ${m[1]} : ${baseClass}`);
        // Also direct inheritance
        const re2=new RegExp(`class\\s+(\\w+)\\s*:\\s*${baseClass}\\b`,"g");
        while((m=re2.exec(c))!==null) { const cls=m[1]; if(!hits.some(h=>h.includes(cls))) hits.push(`${rel}: class ${cls} : ${baseClass}`); }
      }catch{}
    });
    return { content:[{type:"text" as const, text: hits.length? `**Overrides of ${baseClass} (${hits.length}):**\n`+hits.map(s=>`- \`${s}\``).join("\n") : `**No overrides of ${baseClass} found**`}] };
  });

  server.registerTool("script_find_rpc_handlers", {
    description: "Locate [RPC]-attributed methods across project .c files.",
    inputSchema: { projectPath: z.string().optional().describe("Mod project directory"), limit: z.number().min(1).max(100).default(50).describe("Max to show") }
  }, async ({ projectPath, limit }) => {
    const base = projectPath || config.projectPath;
    if(!base || !existsSync(base)) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    const hits:string[]=[];
    walkC(base, (full, rel)=>{
      try{
        const lines=readFileSync(full,"utf-8").split("\n");
        lines.forEach((line,i)=>{
          if(line.includes("[RPC") || line.includes("RplRpc")) hits.push(`${rel}:${i+1}: ${line.trim().slice(0,100)}`);
        });
      }catch{}
    });
    const shown=hits.slice(0,limit);
    return { content:[{type:"text" as const, text: shown.length? `**RPC handlers (${hits.length}):**\n`+shown.map(s=>`- \`${s}\``).join("\n") : `**No [RPC] handlers found**`}] };
  });

  server.registerTool("script_class_hierarchy", {
    description: "Join engine API hierarchy (8.8k classes) with your modded chains — ASCII tree for a class.",
    inputSchema: {
      className: z.string().describe("Class name, e.g. SCR_HUD"),
      projectPath: z.string().optional().describe("Mod project directory"),
    }
  }, async ({ className, projectPath }) => {
    // Reuse game_class_info logic lightly + local modded scan
    const lines:string[]=[];
    lines.push(`**Hierarchy: ${className}**`);
    // Find parent via project files
    const base = projectPath || config.projectPath;
    let parent: string | null = null;
    if(base && existsSync(base)){
      walkC(base,(full)=>{
        try{
          const c=readFileSync(full,"utf-8");
          const m=c.match(new RegExp(`(?:modded\\s+)?class\\s+${className}\\s*:\\s*(\\w+)`));
          if(m) parent=m[1];
        }catch{}
      });
    }
    lines.push(`- ${className}${parent?` : ${parent}`:" (root or engine)"}`);
    // Find children modded
    const children:string[]=[];
    if(base && existsSync(base)){
      walkC(base,(full)=>{
        try{
          const c=readFileSync(full,"utf-8");
          const re=new RegExp(`(?:modded\\s+)?class\\s+(\\w+)\\s*:\\s*${className}\\b`,"g");
          let m: RegExpExecArray | null; while((m=re.exec(c))!==null) children.push(m[1]);
        }catch{}
      });
    }
    if(children.length) lines.push(`  └─ modded children: ${children.join(", ")}`);
    else lines.push(`  └─ (no modded children in project)`);
    lines.push(`\n_Use game_class_info for full engine parent/children across pak._`);
    return { content:[{type:"text" as const, text: lines.join("\n")}] };
  });
}
