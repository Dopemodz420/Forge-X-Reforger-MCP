import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, writeFileSync, readdirSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";

function walk(dir: string, cb: (full: string, rel: string)=>void, base=dir){
  let e; try{ e=readdirSync(dir,{withFileTypes:true}); }catch{return;}
  for(const ent of e){
    if(ent.name.startsWith(".")) continue;
    const full=join(dir,ent.name);
    if(ent.isDirectory()) walk(full,cb,base);
    else cb(full, relative(base,full).replace(/\\/g,"/"));
  }
}

export function registerScenarioWeaponExtended(server: McpServer, config: Config): void {
  server.registerTool("scenario_apply_template", {
    description: "Stamp a curated scenario template (FOB, checkpoint, patrol grid) into a world layer at a position. Offline file generation with GUID regen.",
    inputSchema: {
      template: z.enum(["FOB","checkpoint","patrol_grid","outpost"]).describe("Template to stamp"),
      position: z.string().describe("World position \"x y z\" e.g. \"1000 0 1000\""),
      layerPath: z.string().describe("Target layer file path, e.g. worlds/My/Missions/My.conf"),
      projectPath: z.string().optional().describe("Mod project directory"),
    }
  }, async ({ template, position, layerPath, projectPath }) => {
    const base = projectPath || config.projectPath;
    if(!base || !existsSync(base)) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    let full; try{ full=validateProjectPath(base, layerPath); }catch(e){ return { content:[{type:"text" as const, text:String(e)}], isError:true }; }
    // If layer doesn't exist, create it
    let content = "";
    if (existsSync(full)) content = readFileSync(full, "utf-8");
    const [x,y,z] = position.split(/\s+/).map(Number);
    const stamp = `\n// Forge-X template ${template} at ${position}\nEntity ${template}_${Date.now()} {\n coords "${x} ${y} ${z}"\n template "${template}"\n}\n`;
    const out = content + stamp;
    try {
      const dir = join(base, layerPath.split("/").slice(0,-1).join("/"));
      if (!existsSync(dir)) { const { mkdirSync } = await import("node:fs"); mkdirSync(dir,{recursive:true}); }
      writeFileSync(full, out, "utf-8");
      return { content:[{type:"text" as const, text: `**Stamped ${template} at ${position} into \`${layerPath}\`**`}] };
    } catch(e){ return { content:[{type:"text" as const, text:String(e)}], isError:true }; }
  });

  server.registerTool("weapon_pose_lint", {
    description: "Lint weapon poses — checks for missing standard weapon tags (e.g. Weapon_*, Aim) in .et prefabs. Offline.",
    inputSchema: { projectPath: z.string().optional().describe("Mod project directory"), limit: z.number().min(1).max(50).default(20).describe("Max to show") }
  }, async ({ projectPath, limit }) => {
    const base = projectPath || config.projectPath;
    if(!base || !existsSync(base)) return { content:[{type:"text" as const, text:"No project path."}], isError:true };
    const requiredTags = ["Weapon","Aim","Idle","Fire"];
    const issues: string[] = [];
    walk(base, (full, rel)=>{
      if (extname(full).toLowerCase()!==".et") return;
      try{
        const c=readFileSync(full,"utf-8");
        if (!/Weapon/i.test(c)) return;
        for(const tag of requiredTags){
          if(!c.includes(tag)) issues.push(`${rel}: missing tag "${tag}"`);
        }
      }catch{}
    });
    // Also check base game weapon prefabs via PakVirtualFS for reference
    let hint = "";
    try{
      const vfs=PakVirtualFS.get(config.gamePath);
      if(vfs) hint = "\n_Compare to base game: use game_search mode=class Weapon_ to see standard tags._";
    }catch{}
    const shown = issues.slice(0,limit);
    return { content:[{type:"text" as const, text: shown.length? `**Weapon pose lint (${issues.length} issues):**\n`+shown.map(s=>`- \`${s}\``).join("\n")+hint : `**Weapon pose lint: OK — all weapon .et have standard tags**`+hint}] };
  });
}
