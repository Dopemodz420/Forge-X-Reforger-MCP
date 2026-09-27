import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { buildGuidIndex } from "./asset-search.js";

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

/**
 * Split GUIDs into definitions and references.
 *
 * Enfusion text distinguishes them structurally (see a base-game prefab):
 *   ID "665097CC918BD3CF"                 <- definition: the resource's own id
 *   MeshObject "{665097CCBF94201B}" {     <- definition: the component resource
 *   Object "{E21F21E29839DDF2}system/.../Camera.xob"  <- reference: id + path
 *
 * So a braced GUID *followed by a path* is a reference; everything else defines.
 * Conflating the two makes a dangling reference look "defined" and hides real breakage.
 */
function classifyGuids(content: string): { defined: Set<string>; referenced: Set<string> } {
  const defined = new Set<string>();
  const referenced = new Set<string>();

  // ID "GUID" / GUID "GUID" — the resource's own identity.
  for (const m of content.matchAll(/\b(?:ID|GUID)\s+"([0-9A-Fa-f]{16})"/g)) {
    defined.add(m[1].toUpperCase());
  }

  // Braced GUID, capturing whatever follows the closing brace.
  for (const m of content.matchAll(/\{([0-9A-Fa-f]{16})\}([^\s"{}]*)/g)) {
    const guid = m[1].toUpperCase();
    const suffix = m[2] ?? "";
    // A trailing path (contains a separator or an extension) makes it a reference.
    if (suffix && /[./]/.test(suffix)) referenced.add(guid);
    else defined.add(guid);
  }

  return { defined, referenced };
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
    let pakFiles: number | null = null;
    try {
      const vfs = PakVirtualFS.get(config.gamePath);
      // PakVirtualFS exposes `fileCount`, not `size`.
      if (vfs) pakFiles = vfs.fileCount;
    } catch {}
    const lines = [
      `## Index: ${base}`,
      `- **Files:** ${files} (.c ${c}, .et ${et}, .conf ${conf}, .layout ${layout})`,
      `- **Project GUID refs:** ${guids.size} unique`,
      `- **Base game files indexed:** ${pakFiles === null ? "unavailable (no VFS)" : pakFiles.toLocaleString()}`,
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
    description:
      "Find GUID references in the project that resolve to nothing (ship-blocker). Scans .et/.conf/.c/.layout " +
      "for {GUID} refs and checks each one against files in the project AND the indexed base game (pak/export). " +
      "Only reports a GUID as broken when it is absent from both.",
    inputSchema: {
      projectPath: z.string().optional().describe("Mod project directory"),
      limit: z.number().min(1).max(200).default(50).describe("Max broken to show"),
    }
  }, async ({ projectPath, limit }) => {
    const base = projectPath || config.projectPath;
    if (!base || !existsSync(base)) return { content: [{ type: "text" as const, text: "No project path." }], isError: true };

    // Collect the set of GUIDs the base game knows about.
    //
    // Two sources, cheapest first:
    //   1. buildGuidIndex() — mines GUIDs out of entity catalogs and UI references,
    //      the same index asset_search uses. Reliable and already cached.
    //   2. A bounded sweep of base-game scripts, which reference resource GUIDs as
    //      [Attribute(defvalue: "{GUID}...")] constants.
    //
    // A full 222k-file walk is deliberately avoided: it is slow and still misses
    // GUIDs that only ever appear inside binary .xob payloads.
    const baseGameGuids = new Set<string>();
    let baseGameScanned = false;
    let baseGameSource = "";
    try {
      const vfs = PakVirtualFS.get(config.gamePath);
      if (vfs) {
        const paths = vfs.allFilePaths();
        const { guidMap } = buildGuidIndex(config.gamePath, vfs, paths);
        for (const g of guidMap.values()) baseGameGuids.add(g.toUpperCase());
        baseGameSource = `entity catalogs + UI references (${guidMap.size} entries)`;

        // Supplement with GUIDs declared in scripts — covers component resources
        // (e.g. MeshObject) whose GUID is not tied to a catalogued path.
        let scriptHits = 0;
        for (const p of paths) {
          if (!p.toLowerCase().endsWith(".c")) continue;
          try {
            const buf = vfs.readFile(p);
            const text = typeof buf === "string" ? buf : buf?.toString("utf-8") || "";
            for (const g of text.match(/\b[0-9A-Fa-f]{16}\b/g) || []) {
              const up = g.toUpperCase();
              if (!baseGameGuids.has(up)) { baseGameGuids.add(up); scriptHits++; }
            }
          } catch { /* skip */ }
        }
        if (scriptHits) baseGameSource += ` + scripts (+${scriptHits})`;
        baseGameScanned = true;
      }
    } catch { /* leave baseGameScanned false */ }

    // Project-side definitions, also indexed once.
    const projectFiles: Array<{ rel: string; content: string; refs: Set<string> }> = [];
    const projectDefined = new Set<string>();
    walk(base, (full, rel) => {
      try {
        const content = readFileSync(full, "utf-8");
        const { defined, referenced } = classifyGuids(content);
        for (const g of defined) projectDefined.add(g);
        projectFiles.push({ rel, content, refs: referenced });
      } catch {}
    });

    const broken: string[] = [];
    for (const { rel, content, refs } of projectFiles) {
      for (const guid of refs) {
        if (projectDefined.has(guid)) continue;              // defined in-project
        if (baseGameScanned && baseGameGuids.has(guid)) continue; // defined in base game
        const line = content.split("\n").find((l) => l.toUpperCase().includes(guid))?.trim().slice(0, 100) || "";
        broken.push(`${rel}: {${guid}} — ${line}`);
        if (broken.length >= limit) break;
      }
      if (broken.length >= limit) break;
    }

    const notes: string[] = [];
    if (!baseGameScanned) {
      notes.push(
        `_Base game GUID index unavailable, so base-game-owned GUIDs may be reported as broken. ` +
        `Point \`gamePath\` at an Arma Reforger install for a trustworthy result._`
      );
    } else {
      notes.push(`_Base game index: ${baseGameSource} → ${baseGameGuids.size} distinct GUIDs._`);
    }
    const shown = broken.slice(0, limit);
    const text = shown.length
      ? `**Broken refs (${broken.length}${broken.length >= limit ? "+" : ""}):**\n${shown.map((s) => `- \`${s}\``).join("\n")}` +
        (broken.length > limit ? `\n…and ${broken.length - limit} more` : "") +
        (notes.length ? `\n\n${notes.join("\n")}` : "")
      : `**No broken GUID refs found** — every {GUID} resolves in the project or the indexed base game.` +
        (notes.length ? `\n\n${notes.join("\n")}` : "");
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
