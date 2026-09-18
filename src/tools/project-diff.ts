import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, resolve, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { parse as parseEnfusion, type EnfusionNode } from "../formats/enfusion-text.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

type DiffType = "auto" | "prefab" | "config" | "script" | "layout";

function detectType(filePath: string): DiffType {
  const ext = extname(filePath).toLowerCase();
  switch (ext) {
    case ".et": return "prefab";
    case ".conf": return "config";
    case ".c": return "script";
    case ".layout": return "layout";
    default: return "auto";
  }
}

function readFileContent(
  filePath: string,
  projectPath: string | null,
  config: Config
): { content: string; source: string } | null {
  // Try project path first
  if (projectPath) {
    try {
      const fullPath = validateProjectPath(projectPath, filePath);
      if (existsSync(fullPath)) {
        const stats = statSync(fullPath);
        if (stats.isFile() && stats.size <= 1_000_000) {
          return { content: readFileSync(fullPath, "utf-8"), source: relative(projectPath, fullPath) };
        }
      }
    } catch { /* not in project */ }
  }

  // Try as absolute path
  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (stats.isFile() && stats.size <= 1_000_000) {
      return { content: readFileSync(filePath, "utf-8"), source: filePath };
    }
  }

  // Try game VFS
  try {
    const pakVfs = PakVirtualFS.get(config.gamePath);
    if (pakVfs && pakVfs.exists(filePath)) {
      const fileSize = pakVfs.fileSize(filePath);
      if (fileSize <= 1_000_000) {
        const content = pakVfs.readTextFile(filePath);
        return { content, source: `${filePath} (from .pak)` };
      }
    }
  } catch { /* no VFS */ }

  // Try extracted path
  if (config.extractedPath && existsSync(config.extractedPath)) {
    try {
      const fullPath = validateProjectPath(config.extractedPath, filePath);
      if (existsSync(fullPath)) {
        const stats = statSync(fullPath);
        if (stats.isFile() && stats.size <= 1_000_000) {
          return { content: readFileSync(fullPath, "utf-8"), source: `${filePath} (from extracted)` };
        }
      }
    } catch { /* not in extracted */ }
  }

  return null;
}

function detectDiffType(fileA: string, fileB: string, explicit: DiffType): DiffType {
  if (explicit !== "auto") return explicit;
  const tA = detectType(fileA);
  const tB = detectType(fileB);
  if (tA === tB) return tA;
  return "auto"; // mismatched extensions, fall back to line-by-line
}

// ── Prefab Diff ──────────────────────────────────────────────────────────────

interface PrefabComponent {
  typeName: string;
  className?: string;
  guid: string;
  properties: Map<string, string>;
  rawBody: string;
}

function parsePrefabComponents(content: string): Map<string, PrefabComponent> {
  const components = new Map<string, PrefabComponent>();

  try {
    const root = parseEnfusion(content);
    for (const child of root.children) {
      const guid = child.id ?? "";
      const props = new Map<string, string>();
      for (const p of child.properties) {
        if (typeof p.value === "string") {
          props.set(p.key, p.value);
        }
      }
      components.set(guid, {
        typeName: child.type,
        className: child.className,
        guid,
        properties: props,
        rawBody: "",
      });
    }
  } catch {
    // Fallback: regex extraction
    const compPattern = /^(\w+)(?:\s+(\w+))?\s+"(\{[0-9A-Fa-f-]+\})"/gm;
    let match;
    while ((match = compPattern.exec(content)) !== null) {
      const [, type, className, guid] = match;
      // Extract properties from the block following this component
      const blockStart = content.indexOf("{", match.index);
      if (blockStart === -1) continue;
      let depth = 0;
      let blockEnd = blockStart;
      for (let i = blockStart; i < content.length; i++) {
        if (content[i] === "{") depth++;
        if (content[i] === "}") { depth--; if (depth === 0) { blockEnd = i; break; } }
      }
      const block = content.substring(blockStart + 1, blockEnd);
      const props = new Map<string, string>();
      const propPattern = /^(\w+)\s+"([^"]*)"/gm;
      let propMatch;
      while ((propMatch = propPattern.exec(block)) !== null) {
        props.set(propMatch[1], propMatch[2]);
      }
      components.set(guid, { typeName: type, className, guid, properties: props, rawBody: "" });
    }
  }

  return components;
}

interface DiffEntry {
  kind: "added" | "removed" | "modified";
  label: string;
  changes: Array<{ key: string; oldVal?: string; newVal?: string }>;
}

function diffPrefabs(contentA: string, contentB: string): string {
  const compsA = parsePrefabComponents(contentA);
  const compsB = parsePrefabComponents(contentB);

  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const modified: DiffEntry[] = [];

  // Find components in A not in B (removed)
  for (const [guid, compA] of compsA) {
    const compB = compsB.get(guid);
    if (!compB) {
      const label = compA.className
        ? `${compA.typeName} ${compA.className} "${guid}"`
        : `${compA.typeName} "${guid}"`;
      removed.push({ kind: "removed", label, changes: [] });
      continue;
    }

    // Both exist — compare properties
    const changes: Array<{ key: string; oldVal?: string; newVal?: string }> = [];
    for (const [key, valA] of compA.properties) {
      const valB = compB.properties.get(key);
      if (valB === undefined) {
        changes.push({ key, oldVal: valA, newVal: "(missing)" });
      } else if (valA !== valB) {
        changes.push({ key, oldVal: valA, newVal: valB });
      }
    }
    for (const [key, valB] of compB.properties) {
      if (!compA.properties.has(key)) {
        changes.push({ key, oldVal: "(missing)", newVal: valB });
      }
    }

    if (changes.length > 0) {
      const label = compA.className
        ? `${compA.typeName} ${compA.className} "${guid}"`
        : `${compA.typeName} "${guid}"`;
      modified.push({ kind: "modified", label, changes });
    }
  }

  // Find components in B not in A (added)
  for (const [guid, compB] of compsB) {
    if (!compsA.has(guid)) {
      const label = compB.className
        ? `${compB.typeName} ${compB.className} "${guid}"`
        : `${compB.typeName} "${guid}"`;
      added.push({ kind: "added", label, changes: [] });
    }
  }

  return formatPrefabDiff(added, modified, removed);
}

function formatPrefabDiff(
  added: DiffEntry[],
  modified: DiffEntry[],
  removed: DiffEntry[]
): string {
  const lines: string[] = [];

  if (added.length > 0) {
    lines.push(`### Components Added (+${added.length})`);
    for (const e of added) {
      lines.push(`+ ${e.label}`);
    }
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push(`### Components Modified (${modified.length})`);
    for (const e of modified) {
      lines.push(`~ ${e.label}:`);
      for (const c of e.changes) {
        lines.push(`    ${c.key}: ${c.oldVal} → ${c.newVal}`);
      }
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Components Removed (${removed.length})`);
    for (const e of removed) {
      lines.push(`- ${e.label}`);
    }
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- ${added.length} component(s) added`);
  lines.push(`- ${modified.length} component(s) modified`);
  lines.push(`- ${removed.length} component(s) removed`);

  return lines.join("\n");
}

// ── Config Diff ──────────────────────────────────────────────────────────────

interface ConfigEntry {
  key: string;
  value: string;
  path: string[];
}

function flattenConfig(node: EnfusionNode, prefix: string[] = []): ConfigEntry[] {
  const entries: ConfigEntry[] = [];
  for (const prop of node.properties) {
    const fullPath = [...prefix, prop.key];
    if (typeof prop.value === "string") {
      entries.push({ key: prop.key, value: prop.value, path: fullPath });
    } else {
      entries.push(...flattenConfig(prop.value, fullPath));
    }
  }
  for (const child of node.children) {
    const childPrefix = [...prefix, child.type, child.id ?? ""].filter(Boolean);
    entries.push(...flattenConfig(child, childPrefix));
  }
  return entries;
}

function entriesToMap(entries: ConfigEntry[]): Map<string, ConfigEntry> {
  const map = new Map<string, ConfigEntry>();
  for (const e of entries) {
    map.set(e.path.join("/"), e);
  }
  return map;
}

function diffConfigs(contentA: string, contentB: string): string {
  const lines: string[] = [];

  let nodeA: EnfusionNode;
  let nodeB: EnfusionNode;
  try {
    nodeA = parseEnfusion(contentA);
  } catch (e) {
    return `Error parsing file A: ${e instanceof Error ? e.message : String(e)}`;
  }
  try {
    nodeB = parseEnfusion(contentB);
  } catch (e) {
    return `Error parsing file B: ${e instanceof Error ? e.message : String(e)}`;
  }

  const entriesA = entriesToMap(flattenConfig(nodeA));
  const entriesB = entriesToMap(flattenConfig(nodeB));

  const added: Array<{ label: string; value: string }> = [];
  const removed: Array<{ label: string; value: string }> = [];
  const changed: Array<{ label: string; oldVal: string; newVal: string }> = [];

  for (const [path, entryA] of entriesA) {
    const entryB = entriesB.get(path);
    if (!entryB) {
      removed.push({ label: path, value: entryA.value });
    } else if (entryA.value !== entryB.value) {
      changed.push({ label: path, oldVal: entryA.value, newVal: entryB.value });
    }
  }

  for (const [path, entryB] of entriesB) {
    if (!entriesA.has(path)) {
      added.push({ label: path, value: entryB.value });
    }
  }

  if (added.length > 0) {
    lines.push(`### Keys Added (+${added.length})`);
    for (const e of added) {
      lines.push(`+ ${e.label}: "${e.value}"`);
    }
    lines.push("");
  }

  if (changed.length > 0) {
    lines.push(`### Keys Changed (${changed.length})`);
    for (const e of changed) {
      lines.push(`~ ${e.label}:`);
      lines.push(`    "${e.oldVal}" → "${e.newVal}"`);
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Keys Removed (${removed.length})`);
    for (const e of removed) {
      lines.push(`- ${e.label}: "${e.value}"`);
    }
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- ${added.length} key(s) added`);
  lines.push(`- ${changed.length} key(s) changed`);
  lines.push(`- ${removed.length} key(s) removed`);

  return lines.join("\n");
}

// ── Script Diff ──────────────────────────────────────────────────────────────

interface MethodSig {
  name: string;
  signature: string;
  bodyHash: string;
}

function extractMethods(content: string): Map<string, MethodSig> {
  const methods = new Map<string, MethodSig>();
  // Match method signatures: [modifiers] ReturnType Name(params) { ... }
  const pattern = /^((?:override|protected|private|public|protected\s+override|private\s+override|public\s+override|static|native|event|autoptr\s+ref|ref\s+)*)\s*(\w[\w<>\[\]?,\s]*)\s+(\w+)\s*\(([^)]*)\)\s*\{/gm;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const [, modifiers, returnType, name, params] = match;
    const signature = `${(modifiers ?? "").trim()} ${returnType.trim()} ${name.trim()}(${params.trim()})`.trim();
    // Extract body
    const bodyStart = content.indexOf("{", match.index);
    if (bodyStart === -1) continue;
    let depth = 0;
    let bodyEnd = bodyStart;
    for (let i = bodyStart; i < content.length; i++) {
      if (content[i] === "{") depth++;
      if (content[i] === "}") { depth--; if (depth === 0) { bodyEnd = i; break; } }
    }
    const body = content.substring(bodyStart + 1, bodyEnd);
    // Simple hash for body comparison
    let hash = 0;
    for (let i = 0; i < body.length; i++) {
      hash = ((hash << 5) - hash + body.charCodeAt(i)) | 0;
    }
    methods.set(name, { name, signature, bodyHash: hash.toString(36) });
  }
  return methods;
}

function diffScripts(contentA: string, contentB: string): string {
  const lines: string[] = [];
  const methodsA = extractMethods(contentA);
  const methodsB = extractMethods(contentB);

  const added: MethodSig[] = [];
  const removed: MethodSig[] = [];
  const modified: MethodSig[] = [];

  for (const [name, sigA] of methodsA) {
    const sigB = methodsB.get(name);
    if (!sigB) {
      removed.push(sigA);
    } else if (sigA.bodyHash !== sigB.bodyHash) {
      modified.push(sigA);
    }
  }

  for (const [name, sigB] of methodsB) {
    if (!methodsA.has(name)) {
      added.push(sigB);
    }
  }

  if (added.length > 0) {
    lines.push(`### Methods Added (+${added.length})`);
    for (const m of added) {
      lines.push(`+ ${m.signature}`);
    }
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push(`### Methods Modified (${modified.length})`);
    for (const m of modified) {
      lines.push(`~ ${m.signature}  (body changed)`);
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Methods Removed (${removed.length})`);
    for (const m of removed) {
      lines.push(`- ${m.signature}`);
    }
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- ${added.length} method(s) added`);
  lines.push(`- ${modified.length} method(s) modified`);
  lines.push(`- ${removed.length} method(s) removed`);

  return lines.join("\n");
}

// ── Layout Diff ──────────────────────────────────────────────────────────────

interface WidgetDef {
  name: string;
  type: string;
  properties: Map<string, string>;
}

function parseLayoutWidgets(content: string): Map<string, WidgetDef> {
  const widgets = new Map<string, WidgetDef>();
  // Match widget blocks: WidgetType "Name" { ... }
  const widgetPattern = /^(\w+)\s+"([^"]+)"\s*\{/gm;
  let match;
  while ((match = widgetPattern.exec(content)) !== null) {
    const [, type, name] = match;
    const blockStart = content.indexOf("{", match.index);
    if (blockStart === -1) continue;
    let depth = 0;
    let blockEnd = blockStart;
    for (let i = blockStart; i < content.length; i++) {
      if (content[i] === "{") depth++;
      if (content[i] === "}") { depth--; if (depth === 0) { blockEnd = i; break; } }
    }
    const block = content.substring(blockStart + 1, blockEnd);
    const props = new Map<string, string>();
    const propPattern = /^(\w+)\s+"([^"]*)"/gm;
    let propMatch;
    while ((propMatch = propPattern.exec(block)) !== null) {
      props.set(propMatch[1], propMatch[2]);
    }
    // Also match bare values: Key Value (no quotes)
    const barePattern = /^(\w+)\s+(-?\d+(?:\.\d+)?|true|false)\s*$/gm;
    while ((propMatch = barePattern.exec(block)) !== null) {
      props.set(propMatch[1], propMatch[2]);
    }
    widgets.set(name, { name, type, properties: props });
  }
  return widgets;
}

function diffLayouts(contentA: string, contentB: string): string {
  const lines: string[] = [];
  const widgetsA = parseLayoutWidgets(contentA);
  const widgetsB = parseLayoutWidgets(contentB);

  const added: WidgetDef[] = [];
  const removed: WidgetDef[] = [];
  const modified: Array<{ widget: WidgetDef; changes: Array<{ key: string; oldVal: string; newVal: string }> }> = [];

  for (const [name, widgetA] of widgetsA) {
    const widgetB = widgetsB.get(name);
    if (!widgetB) {
      removed.push(widgetA);
      continue;
    }

    const changes: Array<{ key: string; oldVal: string; newVal: string }> = [];
    for (const [key, valA] of widgetA.properties) {
      const valB = widgetB.properties.get(key);
      if (valB === undefined) {
        changes.push({ key, oldVal: valA, newVal: "(missing)" });
      } else if (valA !== valB) {
        changes.push({ key, oldVal: valA, newVal: valB });
      }
    }
    for (const [key, valB] of widgetB.properties) {
      if (!widgetA.properties.has(key)) {
        changes.push({ key, oldVal: "(missing)", newVal: valB });
      }
    }

    if (changes.length > 0) {
      modified.push({ widget: widgetA, changes });
    }
  }

  for (const [name, widgetB] of widgetsB) {
    if (!widgetsA.has(name)) {
      added.push(widgetB);
    }
  }

  if (added.length > 0) {
    lines.push(`### Widgets Added (+${added.length})`);
    for (const w of added) {
      lines.push(`+ ${w.type} "${w.name}"`);
    }
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push(`### Widgets Modified (${modified.length})`);
    for (const m of modified) {
      lines.push(`~ ${m.widget.type} "${m.widget.name}":`);
      for (const c of m.changes) {
        lines.push(`    ${c.key}: "${c.oldVal}" → "${c.newVal}"`);
      }
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Widgets Removed (${removed.length})`);
    for (const w of removed) {
      lines.push(`- ${w.type} "${w.name}"`);
    }
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- ${added.length} widget(s) added`);
  lines.push(`- ${modified.length} widget(s) modified`);
  lines.push(`- ${removed.length} widget(s) removed`);

  return lines.join("\n");
}

// ── Line-by-line fallback ────────────────────────────────────────────────────

function diffLines(contentA: string, contentB: string): string {
  const linesA = contentA.split("\n");
  const linesB = contentB.split("\n");

  const output: string[] = [];
  const maxLen = Math.max(linesA.length, linesB.length);

  let added = 0;
  let removed = 0;
  let contextLines = 0;

  // Simple LCS-based diff
  const lcs = computeLCS(linesA, linesB);
  let iA = 0, iB = 0, iL = 0;

  while (iA < linesA.length || iB < linesB.length) {
    if (iL < lcs.length && iA < linesA.length && iB < linesB.length && linesA[iA] === lcs[iL] && linesB[iB] === lcs[iL]) {
      // Context line
      output.push(`  ${linesA[iA]}`);
      contextLines++;
      iA++; iB++; iL++;
    } else if (iA < linesA.length && (iL >= lcs.length || linesA[iA] !== lcs[iL])) {
      output.push(`- ${linesA[iA]}`);
      removed++;
      iA++;
    } else if (iB < linesB.length && (iL >= lcs.length || linesB[iB] !== lcs[iL])) {
      output.push(`+ ${linesB[iB]}`);
      added++;
      iB++;
    }
  }

  output.push("");
  output.push("### Summary");
  output.push(`- ${added} line(s) added`);
  output.push(`- ${removed} line(s) removed`);
  output.push(`- ${contextLines} line(s) unchanged`);

  return output.join("\n");
}

function computeLCS(a: string[], b: string[]): string[] {
  const m = a.length;
  const n = b.length;
  // For very large files, skip LCS and do simple line-by-line
  if (m > 2000 || n > 2000) {
    return [];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  // Backtrack
  const result: string[] = [];
  let i = m, j = n;
  while (i > 0 && j > 0) {
    if (a[i - 1] === b[j - 1]) {
      result.unshift(a[i - 1]);
      i--; j--;
    } else if (dp[i - 1][j] > dp[i][j - 1]) {
      i--;
    } else {
      j--;
    }
  }

  return result;
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerProjectDiff(server: McpServer, config: Config): void {
  server.registerTool(
    "project_diff",
    {
      description:
        "Compare two files and show structured differences. " +
        "Supports prefabs (.et), configs (.conf), scripts (.c), and layouts (.layout). " +
        "Auto-detects file type from extension. Prefab diffs compare components by GUID. " +
        "Config diffs compare key-value pairs. Script diffs compare method signatures. " +
        "Layout diffs compare widget properties. Files are resolved from project path, " +
        "then game VFS as fallback.",
      inputSchema: {
        fileA: z.string().describe("First file path (relative to project, absolute, or game VFS path)"),
        fileB: z.string().describe("Second file path (relative to project, absolute, or game VFS path)"),
        type: z
          .enum(["auto", "prefab", "config", "script", "layout"])
          .default("auto")
          .describe("File type override. 'auto' detects from extension."),
        projectPath: z
          .string()
          .optional()
          .describe("Project root directory for resolving relative paths. Uses configured default if omitted."),
      },
    },
    async ({ fileA, fileB, type, projectPath }) => {
      const basePath = projectPath || config.projectPath;

      // Resolve file A
      const fileAData = readFileContent(fileA, basePath, config);
      if (!fileAData) {
        return {
          content: [{ type: "text", text: `File not found: ${fileA}\nTried: project path, absolute path, game VFS.` }],
          isError: true,
        };
      }

      // Resolve file B
      const fileBData = readFileContent(fileB, basePath, config);
      if (!fileBData) {
        return {
          content: [{ type: "text", text: `File not found: ${fileB}\nTried: project path, absolute path, game VFS.` }],
          isError: true,
        };
      }

      // Detect diff type
      const diffType = detectDiffType(fileA, fileB, type);
      const nameA = fileAData.source;
      const nameB = fileBData.source;

      try {
        let diffBody: string;

        switch (diffType) {
          case "prefab":
            diffBody = diffPrefabs(fileAData.content, fileBData.content);
            break;
          case "config":
            diffBody = diffConfigs(fileAData.content, fileBData.content);
            break;
          case "script":
            diffBody = diffScripts(fileAData.content, fileBData.content);
            break;
          case "layout":
            diffBody = diffLayouts(fileAData.content, fileBData.content);
            break;
          default:
            diffBody = diffLines(fileAData.content, fileBData.content);
            break;
        }

        const header = `## Diff: ${nameA} vs ${nameB}\n\n`;
        const typeNote = diffType === "auto"
          ? "> Note: Files have different extensions. Using line-by-line comparison.\n\n"
          : "";

        return {
          content: [{ type: "text", text: header + typeNote + diffBody }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error computing diff: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
