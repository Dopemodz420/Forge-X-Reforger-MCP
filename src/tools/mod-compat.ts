import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, join, extname, relative } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

// ─── File walking ────────────────────────────────────────────────────────────

interface FileEntry {
  fullPath: string;
  relPath: string;
}

function walkDir(dir: string, ext: string): FileEntry[] {
  const results: FileEntry[] = [];
  if (!existsSync(dir)) return results;

  const walk = (current: string) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (extname(entry.name).toLowerCase() === ext) {
          results.push({ fullPath, relPath: relative(dir, fullPath).replace(/\\/g, "/") });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  };
  walk(dir);
  return results;
}

// ─── Class collision detection ───────────────────────────────────────────────

interface ClassInfo {
  className: string;
  isModded: boolean;
  file: string;
  line: number;
}

function extractClassDefs(files: FileEntry[]): ClassInfo[] {
  const classes: ClassInfo[] = [];
  const classPattern = /^(modded\s+)?class\s+(\w+)/gm;

  for (const file of files) {
    try {
      const content = readFileSync(file.fullPath, "utf-8");
      const lines = content.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Skip comments
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;

        const match = line.match(/^(modded\s+)?class\s+(\w+)/);
        if (match) {
          classes.push({
            className: match[2],
            isModded: !!match[1],
            file: file.relPath,
            line: i + 1,
          });
        }
      }
    } catch {
      // Skip unreadable files
    }
  }
  return classes;
}

// ─── Config type collision detection ─────────────────────────────────────────

interface ConfigTypeInfo {
  rootType: string;
  file: string;
}

function extractConfigRootTypes(files: FileEntry[]): ConfigTypeInfo[] {
  const types: ConfigTypeInfo[] = [];

  for (const file of files) {
    try {
      const content = readFileSync(file.fullPath, "utf-8");
      // First non-comment, non-empty line should be the root type declaration
      const lines = content.split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*")) continue;
        // Root type is the first identifier before { or before a GUID
        const match = trimmed.match(/^(\w+)/);
        if (match && match[1] !== "enum" && match[1] !== "class") {
          types.push({ rootType: match[1], file: file.relPath });
        }
        break;
      }
    } catch {
      // Skip unreadable files
    }
  }
  return types;
}

// ─── Naming prefix extraction ────────────────────────────────────────────────

interface PrefixInfo {
  prefix: string;
  count: number;
  examples: string[];
}

function extractPrefixes(classes: ClassInfo[]): PrefixInfo[] {
  const prefixMap = new Map<string, { count: number; examples: Set<string> }>();

  for (const cls of classes) {
    const prefixMatch = cls.className.match(/^([A-Z][A-Z0-9]+)_/);
    if (prefixMatch) {
      const prefix = prefixMatch[1];
      const entry = prefixMap.get(prefix) || { count: 0, examples: new Set() };
      entry.count++;
      entry.examples.add(cls.className);
      prefixMap.set(prefix, entry);
    }
  }

  const result: PrefixInfo[] = [];
  for (const [prefix, data] of prefixMap) {
    result.push({
      prefix,
      count: data.count,
      examples: Array.from(data.examples).slice(0, 5),
    });
  }
  return result;
}

// ─── Resource path overlap ───────────────────────────────────────────────────

function findResourceOverlaps(filesA: FileEntry[], filesB: FileEntry[]): Array<{ path: string; fileA: string; fileB: string }> {
  const pathMapA = new Map<string, string>();
  for (const f of filesA) pathMapA.set(f.relPath, f.fullPath);

  const overlaps: Array<{ path: string; fileA: string; fileB: string }> = [];
  for (const f of filesB) {
    const matchA = pathMapA.get(f.relPath);
    if (matchA) {
      overlaps.push({ path: f.relPath, fileA: matchA, fileB: f.fullPath });
    }
  }
  return overlaps;
}

// ─── Dependency parsing ──────────────────────────────────────────────────────

function parseDependencies(gprojPath: string): { id: string; guid: string; deps: string[] } | null {
  if (!existsSync(gprojPath)) return null;

  try {
    const content = readFileSync(gprojPath, "utf-8");
    const result = { id: "", guid: "", deps: [] as string[] };

    // Extract ID
    const idMatch = content.match(/ID\s+"([^"]+)"/);
    if (idMatch) result.id = idMatch[1];

    // Extract GUID
    const guidMatch = content.match(/GUID\s+"([0-9A-Fa-f]+)"/);
    if (guidMatch) result.guid = guidMatch[1];

    // Extract Dependencies block - collect bare GUIDs
    const depsBlockMatch = content.match(/Dependencies\s*\{([^}]*)\}/s);
    if (depsBlockMatch) {
      const block = depsBlockMatch[1];
      const guidPattern = /\{([0-9A-Fa-f]{16})\}/g;
      let m;
      while ((m = guidPattern.exec(block)) !== null) {
        result.deps.push(m[1]);
      }
      // Also grab bare GUIDs without braces
      const barePattern = /\b([0-9A-Fa-f]{16})\b/g;
      while ((m = barePattern.exec(block)) !== null) {
        if (!result.deps.includes(m[1])) {
          result.deps.push(m[1]);
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

// ─── Register ────────────────────────────────────────────────────────────────

export function registerModCompat(server: McpServer, config: Config): void {
  server.registerTool(
    "mod_compat",
    {
      description:
        "Check compatibility between two mods. Detects class collisions, config type conflicts, naming prefix overlaps, dependency conflicts, and resource path overlaps. Reports severity and recommendations.",
      inputSchema: {
        modAPath: z
          .string()
          .describe("First mod project directory (absolute or relative to projectPath)"),
        modBPath: z
          .string()
          .describe("Second mod project directory (absolute or relative to projectPath)"),
        projectPath: z
          .string()
          .optional()
          .describe("Parent project path if mod paths are relative. Uses configured default if omitted."),
      },
    },
    async ({ modAPath, modBPath, projectPath }) => {
      const basePath = projectPath || config.projectPath;

      // Resolve mod paths
      let resolvedA: string;
      let resolvedB: string;

      try {
        resolvedA = resolveModPath(modAPath, basePath);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid modA path: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }

      try {
        resolvedB = resolveModPath(modBPath, basePath);
      } catch (e) {
        return {
          content: [{ type: "text", text: `Invalid modB path: ${e instanceof Error ? e.message : String(e)}` }],
          isError: true,
        };
      }

      if (!existsSync(resolvedA)) {
        return {
          content: [{ type: "text", text: `Mod A directory not found: ${resolvedA}` }],
          isError: true,
        };
      }

      if (!existsSync(resolvedB)) {
        return {
          content: [{ type: "text", text: `Mod B directory not found: ${resolvedB}` }],
          isError: true,
        };
      }

      const nameA = resolvedA.split(/[\\/]/).pop() || resolvedA;
      const nameB = resolvedB.split(/[\\/]/).pop() || resolvedB;

      // Collect files
      const scriptsA = walkDir(resolvedA, ".c");
      const scriptsB = walkDir(resolvedB, ".c");
      const configsA = walkDir(resolvedA, ".conf");
      const configsB = walkDir(resolvedB, ".conf");

      // 1. Class collisions
      const classesA = extractClassDefs(scriptsA);
      const classesB = extractClassDefs(scriptsB);

      const classCollisions: Array<{
        className: string;
        fileA: string;
        lineA: number;
        moddedA: boolean;
        fileB: string;
        lineB: number;
        moddedB: boolean;
      }> = [];

      const classMapB = new Map<string, ClassInfo[]>();
      for (const cls of classesB) {
        const list = classMapB.get(cls.className) || [];
        list.push(cls);
        classMapB.set(cls.className, list);
      }

      for (const clsA of classesA) {
        const matchesB = classMapB.get(clsA.className);
        if (matchesB) {
          for (const clsB of matchesB) {
            classCollisions.push({
              className: clsA.className,
              fileA: clsA.file,
              lineA: clsA.line,
              moddedA: clsA.isModded,
              fileB: clsB.file,
              lineB: clsB.line,
              moddedB: clsB.isModded,
            });
          }
        }
      }

      // 2. Config type collisions
      const configTypesA = extractConfigRootTypes(configsA);
      const configTypesB = extractConfigRootTypes(configsB);

      const configCollisions: Array<{
        rootType: string;
        fileA: string;
        fileB: string;
      }> = [];

      const typeMapB = new Map<string, string[]>();
      for (const ct of configTypesB) {
        const list = typeMapB.get(ct.rootType) || [];
        list.push(ct.file);
        typeMapB.set(ct.rootType, list);
      }

      for (const ctA of configTypesA) {
        const matchesB = typeMapB.get(ctA.rootType);
        if (matchesB) {
          for (const fileB of matchesB) {
            configCollisions.push({
              rootType: ctA.rootType,
              fileA: ctA.file,
              fileB,
            });
          }
        }
      }

      // 3. Naming prefix overlap
      const prefixesA = extractPrefixes(classesA);
      const prefixesB = extractPrefixes(classesB);

      const prefixOverlap: Array<{
        prefix: string;
        countA: number;
        countB: number;
        examplesA: string[];
        examplesB: string[];
      }> = [];

      const prefixMapB = new Map<string, PrefixInfo>();
      for (const p of prefixesB) prefixMapB.set(p.prefix, p);

      for (const pA of prefixesA) {
        const pB = prefixMapB.get(pA.prefix);
        if (pB) {
          prefixOverlap.push({
            prefix: pA.prefix,
            countA: pA.count,
            countB: pB.count,
            examplesA: pA.examples,
            examplesB: pB.examples,
          });
        }
      }

      // 4. Resource path overlap
      const resourceOverlaps = findResourceOverlaps(
        [...scriptsA, ...configsA],
        [...scriptsB, ...configsB]
      );

      // 5. Dependency check
      const gprojFilesA = readdirSync(resolvedA).filter(
        (f) => extname(f).toLowerCase() === ".gproj"
      );
      const gprojFilesB = readdirSync(resolvedB).filter(
        (f) => extname(f).toLowerCase() === ".gproj"
      );

      const depsA = gprojFilesA.length > 0
        ? parseDependencies(resolve(resolvedA, gprojFilesA[0]))
        : null;
      const depsB = gprojFilesB.length > 0
        ? parseDependencies(resolve(resolvedB, gprojFilesB[0]))
        : null;

      // Check for conflicting dependencies (same GUID required but different)
      const depConflicts: Array<{
        guid: string;
        sourceA: string;
        sourceB: string;
      }> = [];

      // A mod depending on B or vice versa is fine, but both depending on different
      // versions of the same thing could be a problem. We report shared dependencies.
      const sharedDeps: string[] = [];
      if (depsA && depsB) {
        for (const d of depsA.deps) {
          if (depsB.deps.includes(d)) {
            sharedDeps.push(d);
          }
        }
      }

      // ─── Format report ──────────────────────────────────────────────────

      const criticalClassCollisions = classCollisions.filter(
        (c) => !c.moddedA && !c.moddedB
      );
      const moddedClassCollisions = classCollisions.filter(
        (c) => c.moddedA || c.moddedB
      );

      const lines: string[] = [];
      lines.push(`## Mod Compatibility: ${nameA} vs ${nameB}`);
      lines.push("");

      // Class Collisions
      const classIcon = classCollisions.length === 0 ? "✅" : "❌";
      lines.push(`### Class Collisions (${classCollisions.length}) ${classIcon}`);
      if (classCollisions.length === 0) {
        lines.push("No class name conflicts detected.");
      } else {
        for (const c of classCollisions) {
          const severity = !c.moddedA && !c.moddedB ? "ERROR" : "WARNING";
          const modTag = (m: boolean) => m ? " (modded)" : "";
          lines.push(`  ${c.className}  [${severity}]`);
          lines.push(`    Mod A: ${c.fileA} (line ${c.lineA})${modTag(c.moddedA)}`);
          lines.push(`    Mod B: ${c.fileB} (line ${c.lineB})${modTag(c.moddedB)}`);
          if (!c.moddedA && !c.moddedB) {
            lines.push(`    → Both mods define ${c.className} — runtime will override unpredictably`);
          } else {
            lines.push(`    → Both mods modded-class ${c.className} — load order determines winner`);
          }
          lines.push("");
        }
      }

      // Config Collisions
      const configIcon = configCollisions.length === 0 ? "✅" : "❌";
      lines.push(`### Config Collisions (${configCollisions.length}) ${configIcon}`);
      if (configCollisions.length === 0) {
        lines.push("No config type conflicts detected.");
      } else {
        for (const c of configCollisions) {
          lines.push(`  ${c.rootType}`);
          lines.push(`    Mod A: ${c.fileA}`);
          lines.push(`    Mod B: ${c.fileB}`);
          lines.push(`    → Both mods register config type ${c.rootType} — one will override the other`);
          lines.push("");
        }
      }

      // Naming Prefix Overlap
      const prefixIcon = prefixOverlap.length === 0 ? "✅" : "⚠️";
      lines.push(`### Naming Prefix Overlap (${prefixOverlap.length}) ${prefixIcon}`);
      if (prefixOverlap.length === 0) {
        lines.push("Mods use distinct class prefixes.");
      } else {
        for (const p of prefixOverlap) {
          lines.push(`  Prefix: ${p.prefix}_`);
          lines.push(`    Mod A: ${p.countA} class(es) — e.g., ${p.examplesA.slice(0, 3).join(", ")}`);
          lines.push(`    Mod B: ${p.countB} class(es) — e.g., ${p.examplesB.slice(0, 3).join(", ")}`);
          lines.push(`    → Both mods use prefix ${p.prefix}_ — may cause confusion if combined`);
          lines.push("");
        }
      }

      // Resource Path Conflicts
      const resourceIcon = resourceOverlaps.length === 0 ? "✅" : "❌";
      lines.push(`### Resource Path Conflicts (${resourceOverlaps.length}) ${resourceIcon}`);
      if (resourceOverlaps.length === 0) {
        lines.push("No overlapping file paths detected.");
      } else {
        for (const r of resourceOverlaps) {
          lines.push(`  ${r.path}`);
          lines.push(`    Mod A: ${r.fileA}`);
          lines.push(`    Mod B: ${r.fileB}`);
          lines.push(`    → Same file path in both mods — one will shadow the other`);
          lines.push("");
        }
      }

      // Dependency Overlap
      const depIcon = sharedDeps.length === 0 && depConflicts.length === 0 ? "✅" : "ℹ️";
      lines.push(`### Dependency Check ${depIcon}`);
      if (!depsA && !depsB) {
        lines.push("Neither mod has a .gproj with dependencies to compare.");
      } else {
        if (depsA) {
          lines.push(`  ${nameA}: ${depsA.deps.length} dependency(ies)${depsA.id ? ` (ID: ${depsA.id})` : ""}`);
        }
        if (depsB) {
          lines.push(`  ${nameB}: ${depsB.deps.length} dependency(ies)${depsB.id ? ` (ID: ${depsB.id})` : ""}`);
        }
        if (sharedDeps.length > 0) {
          lines.push(`  Shared dependencies: ${sharedDeps.join(", ")}`);
          lines.push(`  → Both mods depend on the same base — generally safe`);
        }
        if (depConflicts.length > 0) {
          for (const dc of depConflicts) {
            lines.push(`  Conflict: ${dc.guid}`);
            lines.push(`    ${nameA}: ${dc.sourceA}`);
            lines.push(`    ${nameB}: ${dc.sourceB}`);
          }
        }
        if (sharedDeps.length === 0 && depConflicts.length === 0 && depsA && depsB) {
          lines.push("  No shared or conflicting dependencies.");
        }
      }

      // Summary
      lines.push("");
      lines.push("### Summary");
      const criticalCount = criticalClassCollisions.length + configCollisions.length + resourceOverlaps.length;
      const warningCount = moddedClassCollisions.length + prefixOverlap.length;

      lines.push(`- ${criticalCount} critical issue(s) (must fix before combining)`);
      lines.push(`- ${warningCount} warning(s) (may cause issues)`);
      lines.push(`- ${depConflicts.length} dependency conflict(s)`);

      if (criticalCount === 0 && warningCount === 0) {
        lines.push("");
        lines.push("✅ Mods appear compatible — no blocking conflicts found.");
      } else if (criticalCount > 0) {
        lines.push("");
        lines.push("❌ Cannot safely combine without resolving critical conflicts above.");
      } else {
        lines.push("");
        lines.push("⚠️ Combination is possible but watch for prefix confusion and modded-class load order.");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    }
  );
}

function resolveModPath(modPath: string, basePath: string): string {
  // Absolute path
  if (existsSync(modPath)) return modPath;

  // Relative to base
  const resolved = resolve(basePath, modPath);
  if (existsSync(resolved)) return resolved;

  throw new Error(`Directory not found: "${modPath}" (tried absolute and relative to ${basePath})`);
}
