import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Config } from "../config.js";
import {
  walkChain,
  mergeAncestryComponents,
  parseTopLevelComponents,
  readEtFile,
  type AncestorLevel,
  type ParsedComponent,
  type MergedComponent,
} from "../utils/prefab-ancestry.js";

// ── Types ─────────────────────────────────────────────────────────────────────

interface PropertyDiff {
  key: string;
  oldVal: string;
  newVal: string;
}

interface ComponentDiffEntry {
  kind: "added" | "removed" | "modified";
  typeName: string;
  guid: string;
  changes: PropertyDiff[];
}

// ── Property parsing ──────────────────────────────────────────────────────────

function parseProperties(rawBody: string): Map<string, string> {
  const props = new Map<string, string>();
  const lines = rawBody.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//")) continue;

    // Quoted value: Key "value" or Key {GUID}path "value"
    const quoted = /^(\w+)\s+(?:"([^"]*)"|(?:\{[0-9A-Fa-f]{16}\})([^\s{]*))/i.exec(trimmed);
    if (quoted) {
      const key = quoted[1];
      const val = quoted[2] !== undefined ? quoted[2] : quoted[3];
      props.set(key, val);
      continue;
    }

    // Bare value: Key Value
    const bare = /^(\w+)\s+([^\s{].*)$/.exec(trimmed);
    if (bare) {
      props.set(bare[1], bare[2]);
    }
  }
  return props;
}

// ── Diffing ───────────────────────────────────────────────────────────────────

interface ComponentLike {
  comp: ParsedComponent;
}

function wrapParsedComponents(comps: Map<string, ParsedComponent>): Map<string, ComponentLike> {
  const wrapped = new Map<string, ComponentLike>();
  for (const [guid, comp] of comps) {
    wrapped.set(guid, { comp });
  }
  return wrapped;
}

function diffMergedComponents(
  mergedA: Map<string, ComponentLike>,
  mergedB: Map<string, ComponentLike>
): ComponentDiffEntry[] {
  const entries: ComponentDiffEntry[] = [];

  // Removed: in A but not in B
  for (const [guid, { comp: compA }] of mergedA) {
    if (!mergedB.has(guid)) {
      entries.push({
        kind: "removed",
        typeName: compA.typeName,
        guid,
        changes: [],
      });
    }
  }

  // Added: in B but not in A
  for (const [guid, { comp: compB }] of mergedB) {
    if (!mergedA.has(guid)) {
      entries.push({
        kind: "added",
        typeName: compB.typeName,
        guid,
        changes: [],
      });
    }
  }

  // Modified: in both but different
  for (const [guid, { comp: compA }] of mergedA) {
    const compB = mergedB.get(guid);
    if (!compB) continue;

    const propsA = parseProperties(compA.rawBody);
    const propsB = parseProperties(compB.comp.rawBody);

    const changes: PropertyDiff[] = [];

    for (const [key, valA] of propsA) {
      const valB = propsB.get(key);
      if (valB === undefined) {
        changes.push({ key, oldVal: valA, newVal: "(missing)" });
      } else if (valA !== valB) {
        changes.push({ key, oldVal: valA, newVal: valB });
      }
    }

    for (const [key, valB] of propsB) {
      if (!propsA.has(key)) {
        changes.push({ key, oldVal: "(missing)", newVal: valB });
      }
    }

    if (changes.length > 0) {
      entries.push({
        kind: "modified",
        typeName: compA.typeName,
        guid,
        changes,
      });
    }
  }

  return entries;
}

// ── Formatting ────────────────────────────────────────────────────────────────

function formatAncestry(
  nameA: string,
  chainA: AncestorLevel[],
  nameB: string,
  chainB: AncestorLevel[],
  warningsA: string[],
  warningsB: string[]
): string {
  const lines: string[] = ["### Ancestry"];

  if (chainA.length === 0) {
    lines.push(`  A: ${nameA} (could not read)`);
  } else {
    const leafA = chainA[chainA.length - 1];
    const parentA = chainA.length > 1 ? chainA[chainA.length - 2] : null;
    if (parentA) {
      lines.push(`  A: ${leafA.path} → ${parentA.path} (${chainA.length} levels)`);
    } else {
      lines.push(`  A: ${leafA.path} (root, no parent)`);
    }
  }

  if (chainB.length === 0) {
    lines.push(`  B: ${nameB} (could not read)`);
  } else {
    const leafB = chainB[chainB.length - 1];
    const parentB = chainB.length > 1 ? chainB[chainB.length - 2] : null;
    if (parentB) {
      lines.push(`  B: ${leafB.path} → ${parentB.path} (${chainB.length} levels)`);
    } else {
      lines.push(`  B: ${leafB.path} (root, no parent)`);
    }
  }

  // Detect shared ancestor
  const pathsA = new Set(chainA.map((l) => l.path.toLowerCase()));
  const sharedAncestors = chainB.filter((l) => pathsA.has(l.path.toLowerCase()));
  if (sharedAncestors.length > 0) {
    const closest = sharedAncestors[sharedAncestors.length - 1];
    lines.push(`  Both share common ancestor: ${closest.path}`);
  }

  if (warningsA.length > 0 || warningsB.length > 0) {
    lines.push("");
    for (const w of warningsA) lines.push(`  WARNING (A): ${w}`);
    for (const w of warningsB) lines.push(`  WARNING (B): ${w}`);
  }

  return lines.join("\n");
}

function formatEntries(entries: ComponentDiffEntry[]): string {
  const lines: string[] = [];

  const added = entries.filter((e) => e.kind === "added");
  const modified = entries.filter((e) => e.kind === "modified");
  const removed = entries.filter((e) => e.kind === "removed");

  if (added.length > 0) {
    lines.push(`### Components Added (+${added.length})`);
    for (const e of added) {
      lines.push(`+ ${e.typeName}`);
    }
    lines.push("");
  }

  if (modified.length > 0) {
    lines.push(`### Components Modified (${modified.length})`);
    for (const e of modified) {
      lines.push(`~ ${e.typeName}:`);
      for (const c of e.changes) {
        lines.push(`    ${c.key}: "${c.oldVal}" → "${c.newVal}"`);
      }
    }
    lines.push("");
  }

  if (removed.length > 0) {
    lines.push(`### Components Removed (${removed.length})`);
    for (const e of removed) {
      lines.push(`- ${e.typeName}`);
    }
    lines.push("");
  }

  lines.push("### Summary");
  lines.push(`- ${added.length} added, ${modified.length} modified, ${removed.length} removed`);

  return lines.join("\n");
}

// ── Registration ──────────────────────────────────────────────────────────────

export function registerPrefabDiff(server: McpServer, config: Config): void {
  server.registerTool(
    "prefab_diff",
    {
      description:
        "Compare two Arma Reforger prefab (.et) files and show structured component-level differences. " +
        "Parses Enfusion text serialization to extract component blocks (each has a type and GUID). " +
        "Reports components added, removed, and modified between the two prefabs with property-level diffs. " +
        "When includeAncestry=true, walks the full inheritance chain for each prefab using the ancestry walker, " +
        "then compares the merged (resolved) component sets — showing differences across the entire hierarchy " +
        "rather than just the leaf files. Useful for comparing variant prefabs that share a common base.",
      inputSchema: {
        prefabA: z.string().describe("First prefab path (relative to project, absolute, or game VFS path)"),
        prefabB: z.string().describe("Second prefab path (relative to project, absolute, or game VFS path)"),
        projectPath: z
          .string()
          .optional()
          .describe("Mod project directory for resolving relative paths. Uses configured default if omitted."),
        includeAncestry: z
          .boolean()
          .default(false)
          .describe(
            "Whether to resolve and compare full inheritance chains. " +
            "When false, compares only the direct component blocks in each .et file. " +
            "When true, walks the parent chain for each prefab and compares merged component sets."
          ),
      },
    },
    async ({ prefabA, prefabB, projectPath, includeAncestry }) => {
      const basePath = projectPath || config.projectPath;

      try {
        const nameA = prefabA.split("/").pop() ?? prefabA;
        const nameB = prefabB.split("/").pop() ?? prefabB;

        if (includeAncestry) {
          const chainA = walkChain(prefabA, config, basePath);
          const chainB = walkChain(prefabB, config, basePath);

          if (chainA.levels.length === 0) {
            return {
              content: [{
                type: "text",
                text: `Could not read prefab A: ${prefabA}\n` +
                  (chainA.warnings.length > 0 ? chainA.warnings.join("\n") : "File not found."),
              }],
              isError: true,
            };
          }

          if (chainB.levels.length === 0) {
            return {
              content: [{
                type: "text",
                text: `Could not read prefab B: ${prefabB}\n` +
                  (chainB.warnings.length > 0 ? chainB.warnings.join("\n") : "File not found."),
              }],
              isError: true,
            };
          }

          const mergedA = mergeAncestryComponents(chainA.levels);
          const mergedB = mergeAncestryComponents(chainB.levels);

          const entries = diffMergedComponents(mergedA, mergedB);

          const header = `## Prefab Diff: ${nameA} vs ${nameB}\n\n`;
          const ancestry = formatAncestry(
            nameA, chainA.levels, nameB, chainB.levels,
            chainA.warnings, chainB.warnings
          );
          const body = entries.length > 0
            ? formatEntries(entries)
            : "### No Differences\n\nBoth prefabs have identical merged component sets.";

          return {
            content: [{ type: "text", text: header + ancestry + "\n\n" + body }],
          };
        }

        // Direct file-level diff (no ancestry resolution)
        const contentA = readEtFile(prefabA, config, basePath);
        const contentB = readEtFile(prefabB, config, basePath);

        if (!contentA) {
          return {
            content: [{ type: "text", text: `Could not read prefab A: ${prefabA}` }],
            isError: true,
          };
        }

        if (!contentB) {
          return {
            content: [{ type: "text", text: `Could not read prefab B: ${prefabB}` }],
            isError: true,
          };
        }

        const compsA = wrapParsedComponents(parseTopLevelComponents(contentA));
        const compsB = wrapParsedComponents(parseTopLevelComponents(contentB));

        const entries = diffMergedComponents(compsA, compsB);

        const header = `## Prefab Diff: ${nameA} vs ${nameB}\n\n`;
        const body = entries.length > 0
          ? formatEntries(entries)
          : "### No Differences\n\nBoth files have identical component blocks.";

        return {
          content: [{ type: "text", text: header + body }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error computing prefab diff: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
