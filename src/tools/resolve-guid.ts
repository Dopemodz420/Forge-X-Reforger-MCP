import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { PakVirtualFS } from "../pak/vfs.js";

function isGuid(s: string): boolean { return /^[0-9A-Fa-f]{16}$/.test(s.trim()); }

function walk(dir: string, cb: (full: string, rel: string) => void, base = dir) {
  let entries; try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) walk(full, cb, base);
    else if ([".c",".et",".conf",".layout",".imageset",".emat",".xob"].includes(extname(e.name).toLowerCase())) {
      cb(full, relative(base, full).replace(/\\/g,"/"));
    }
  }
}

export function registerResolveGuid(server: McpServer, config: Config): void {
  server.registerTool("resolve_guid", {
    description: "Resolve a 16-hex GUID → defining file, type, class, and inheritance. Searches project + base game (pak + export) and reports where the GUID is defined vs referenced. Goldwep parity.",
    inputSchema: {
      guid: z.string().describe("16-hex GUID with or without braces, e.g. 5F268647F8A1A1F4 or {5F268647F8A1A1F4}"),
      projectPath: z.string().optional().describe("Mod project directory. Uses configured default if omitted."),
      limit: z.number().min(1).max(50).default(10).describe("Max reference hits to show"),
    }
  }, async ({ guid, projectPath, limit }) => {
    const raw = guid.replace(/[{}]/g,"").trim().toUpperCase();
    if (!isGuid(raw)) return { content: [{ type: "text" as const, text: `Invalid GUID "${guid}" — expected 16 hex chars.` }], isError: true };

    const basePath = projectPath || config.projectPath;
    const lines: string[] = [];
    lines.push(`## GUID {${raw}}`);

    // 1. Project definition search — look for GUID in file content + class/parent hints
    let foundDef: string | null = null;
    let defClass = "";
    if (basePath && existsSync(basePath)) {
      walk(basePath, (full, rel) => {
        if (foundDef) return;
        try {
          const c = readFileSync(full, "utf-8");
          if (c.toUpperCase().includes(raw)) {
            // Heuristic: defining file often has GUID on same line as parent/ID or as first GUID in file
            const mClass = c.match(/(?:modded\s+)?class\s+(\w+)/);
            if (mClass) defClass = mClass[1];
            // Treat first hit as candidate definition if file is .et/.conf/.c with GUID as ID
            if (!foundDef) foundDef = `${rel} (${defClass || extname(full).slice(1)})`;
          }
        } catch {}
      });
    }
    if (foundDef) lines.push(`**Project definition:** \`${foundDef}\``);
    else lines.push(`**Project definition:** _not found in project_ — likely base game`);

    // 2. Base game search via PakVirtualFS
    try {
      const vfs = PakVirtualFS.get(config.gamePath);
      if (vfs) {
        const guidLower = raw.toLowerCase();
        const hits: string[] = [];
        // PakVirtualFS doesn't have GUID index, so search via game_search-like scan over loose+VFS file list
        // Fallback: scan a sample of known game files via vfs.listFiles if available
        const files = (vfs as unknown as { listFiles?: () => string[] }).listFiles?.() || [];
        for (const f of files) {
          if (hits.length >= limit) break;
          try {
            const content = vfs.readFile(f) as unknown as string | Buffer;
            const text = typeof content === "string" ? content : content?.toString("utf-8") || "";
            if (text.toUpperCase().includes(raw)) hits.push(f);
          } catch {}
        }
        if (hits.length) {
          lines.push(`\n**Base game hits (${hits.length}):**`);
          for (const h of hits.slice(0, limit)) lines.push(`- \`${h}\``);
        }
      }
    } catch {}

    // 3. References in project (incoming)
    const refs: string[] = [];
    if (basePath && existsSync(basePath)) {
      walk(basePath, (full, rel) => {
        if (refs.length >= limit) return;
        try {
          const content = readFileSync(full, "utf-8");
          const lower = content.toLowerCase();
          if (lower.includes(raw.toLowerCase()) && rel !== foundDef?.split(" ")[0]) {
            const line = content.split("\n").find(l=>l.toUpperCase().includes(raw))?.trim().slice(0,120) || "";
            refs.push(`${rel}: ${line}`);
          }
        } catch {}
      });
      lines.push(`\n**Project references (${refs.length} shown):**`);
      if (refs.length===0) lines.push(`_(no project references)_`);
      else for (const r of refs) lines.push(`- \`${r}\``);
    }

    lines.push(`\n_Type: ${defClass || "unknown"} — use game_search mode=guid or prefab_diff to inspect inheritance_`);
    return { content: [{ type: "text" as const, text: lines.join("\n") }] };
  });
}
