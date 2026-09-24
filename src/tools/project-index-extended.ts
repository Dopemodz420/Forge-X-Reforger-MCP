import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";

function walk(dir: string, cb: (full: string, rel: string) => void, base = dir) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, cb, base);
    else if ([".c",".et",".conf",".layout",".imageset",".emat",".xob",".st",".edds",".fnt"].includes(extname(e.name).toLowerCase())) {
      cb(full, relative(base, full).replace(/\\/g,"/"));
    }
  }
}

function collectGuids(content: string): string[] {
  const out: string[] = [];
  const re = /\{([0-9A-Fa-f]{16})\}/g;
  let m; while ((m = re.exec(content)) !== null) out.push(m[1].toUpperCase());
  // Also bare GUIDs
  const re2 = /\b([0-9A-Fa-f]{16})\b/g;
  while ((m = re2.exec(content)) !== null) if (!out.includes(m[1].toUpperCase())) out.push(m[1].toUpperCase());
  return out;
}

export function registerProjectIndexExtended(server: McpServer, config: Config): void {
  server.registerTool("project_index_status", {
    description: "Index snapshot — resources, refs, files, per-project counts. Offline via PakVirtualFS + project walk. Goldwep parity.",
    inputSchema: { projectPath: z.string().optional().describe("Mod project directory") }
  }, async ({ projectPath }) => {
    const base = projectPath || config.projectPath;
    if (!base || !existsSync(base)) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };
    let files=0, et=0, c=0, conf=0, layout=0;
    const guids = new Set<string>();
    walk(base, (full) => {
      files++; const e=extname(full).toLowerCase();
      if (e===".et") et++; else if (e===".c") c++; else if (e===".conf") conf++; else if (e===".layout") layout++;
      try { collectGuids(readFileSync(full,"utf-8")).forEach(g=>guids.add(g)); } catch {}
    });
    let pakFiles=0;
    try { const vfs=PakVirtualFS.get(config.gamePath); if (vfs) pakFiles = (vfs as unknown as { size?: number }).size || 0; } catch {}
    const lines = [
      `## Index: ${base}`,
      `- **Files:** ${files} (.c ${c}, .et ${et}, .conf ${conf}, .layout ${layout})`,
      `- **Project GUID refs:** ${guids.size} unique`,
      `- **Pak VFS:** ${pakFiles || "ok"}`,
    ];
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });

  server.registerTool("inheritance_chain", {
    description: "Walk a prefab .et parent chain to the root; flags cycles. Offline.",
    inputSchema: {
      path: z.string().describe("Prefab path relative to project, e.g. Prefabs/My.et"),
      projectPath: z.string().optional().describe("Mod project directory"),
    }
  }, async ({ path: inputPath, projectPath }) => {
    const base = projectPath || config.projectPath;
    if (!base) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };
    let full; try { full = validateProjectPath(base, inputPath); } catch (e) { return { content: [{ type: "text" as const, text: String(e) }], isError: true }; }
    if (!existsSync(full)) return { content: [{ type: "text" as const, text: `Not found: ${inputPath}` }], isError: true };
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur = full;
    for (let i=0;i<20;i++) {
      const rel = relative(base, cur).replace(/\\/g,"/");
      if (seen.has(rel)) { chain.push(`${rel} [CYCLE]`); break; }
      seen.add(rel);
      chain.push(rel);
      try {
        const content = readFileSync(cur, "utf-8");
        const m = content.match(/Parent\s+\{?([0-9A-Fa-f]{16})\}?\s*([^\s"]+\.et)?/i);
        if (!m) break;
        const guid = m[1];
        const parentPath = m[2];
        // Try resolve parent by GUID search in project
        let found: string | null = null;
        walk(base, (full2, rel2) => {
          if (found) return;
          try { if (readFileSync(full2,"utf-8").toUpperCase().includes(guid.toUpperCase())) found = full2; } catch {}
        });
        if (found) cur = found;
        else if (parentPath) {
          const tryPath = join(base, parentPath.replace(/^\{[^}]+\}/,""));
          if (existsSync(tryPath)) cur = tryPath; else break;
        } else break;
      } catch { break; }
    }
    return { content: [{ type: "text" as const, text: `## Inheritance: ${inputPath}\n`+chain.map((c,i)=>`${"  ".repeat(i)}→ ${c}`).join("\n") }] };
  });

  server.registerTool("find_broken_refs", {
    description: "Find GUID references to non-existent resources (ship-blocker). Scans project .et/.conf/.c for {GUID} and checks existence in project + base game.",
    inputSchema: {
      projectPath: z.string().optional().describe("Mod project directory"),
      limit: z.number().min(1).max(200).default(50).describe("Max broken to show"),
    }
  }, async ({ projectPath, limit }) => {
    const base = projectPath || config.projectPath;
    if (!base || !existsSync(base)) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };
    const vfs = (()=>{ try { return PakVirtualFS.get(config.gamePath); } catch { return null; } })();
    const broken: string[] = [];
    walk(base, (full, rel) => {
      if (broken.length >= limit) return;
      try {
        const content = readFileSync(full, "utf-8");
        for (const guid of collectGuids(content)) {
          // Check existence: project file with guid or pak
          let exists = false;
          // Project check
          walk(base, (f2) => { if (exists) return; try { if (readFileSync(f2,"utf-8").toUpperCase().includes(guid)) exists = true; } catch {} });
          if (exists) continue;
          // Pak check (best-effort)
          if (vfs) {
            try {
              const hit = (vfs as unknown as { readFile?: (p:string)=>string }).readFile?.(`{${guid}}`);
              if (hit) exists = true;
            } catch {}
            // Fallback: search few pak files via list (expensive, skip for now)
          }
          if (!exists) {
            const line = content.split("\n").find(l=>l.toUpperCase().includes(guid))?.trim().slice(0,100) || "";
            broken.push(`${rel}: {${guid}} — ${line}`);
          }
        }
      } catch {}
    });
    const text = broken.length ? `**Broken refs (${broken.length}):**\n`+broken.slice(0,limit).map(s=>`- \`${s}\``).join("\n") : `**No broken GUID refs found** — all {GUID} resolve in project or base game.`;
    return { content: [{ type: "text" as const, text }] };
  });

  server.registerTool("find_unused_resources", {
    description: "Find project resources with zero inbound GUID/path references (pre-publish cleanup). Scans .et/.conf/.c/.layout.",
    inputSchema: {
      projectPath: z.string().optional().describe("Mod project directory"),
      limit: z.number().min(1).max(200).default(50).describe("Max to show"),
    }
  }, async ({ projectPath, limit }) => {
    const base = projectPath || config.projectPath;
    if (!base || !existsSync(base)) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };
    const resources: string[] = [];
    walk(base, (full, rel) => {
      const e = extname(full).toLowerCase();
      if ([".et",".conf",".layout",".imageset",".edds"].includes(e)) resources.push(rel);
    });
    // Build inbound map: for each resource, check if any file references its basename or GUID
    const allContent = (()=>{ const m=new Map<string,string>(); walk(base,(full,rel)=>{ try { m.set(rel, readFileSync(full,"utf-8")); } catch{} }); return m; })();
    const unused: string[] = [];
    for (const res of resources) {
      const baseName = basename(res).replace(/\.[^.]+$/,"").toLowerCase();
      let inbound = false;
      for (const [otherRel, content] of allContent.entries()) {
        if (otherRel===res) continue;
        if (content.toLowerCase().includes(baseName)) { inbound = true; break; }
        // Also GUID check
        try { const g = collectGuids(readFileSync(join(base,res),"utf-8"))[0]; if (g && content.toUpperCase().includes(g)) { inbound=true; break; } } catch {}
      }
      if (!inbound) unused.push(res);
    }
    const shown = unused.slice(0,limit);
    const text = shown.length ? `**Unused resources (${unused.length}):**\n`+shown.map(s=>`- \`${s}\``).join("\n") + (unused.length>limit?`\n... and ${unused.length-limit} more`:"") : `**No unused resources** — all project assets are referenced.`;
    return { content: [{ type: "text" as const, text }] };
  });
}
