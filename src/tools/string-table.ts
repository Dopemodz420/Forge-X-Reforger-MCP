import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, extname, relative, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";

// ─── helpers ──────────────────────────────────────────────────────────────────

const STR_KEY_REGEX = /#(STR_\w+)/g;
const STR_REF_REGEX = /#(STR_[A-Za-z0-9_]+)/g;

function walkFiles(
  dir: string,
  extensions: string[],
  callback: (filePath: string, relPath: string) => void,
  baseDir?: string,
): void {
  const base = baseDir ?? dir;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, extensions, callback, base);
    } else if (extensions.includes(extname(entry.name).toLowerCase())) {
      callback(fullPath, relative(base, fullPath).replace(/\\/g, "/"));
    }
  }
}

function extractKeysFromFile(filePath: string): string[] {
  try {
    const content = readFileSync(filePath, "utf-8");
    const keys: string[] = [];
    let match: RegExpExecArray | null;
    const regex = new RegExp(STR_REF_REGEX.source, "g");
    while ((match = regex.exec(content)) !== null) {
      keys.push(match[1]);
    }
    return keys;
  } catch {
    return [];
  }
}

// ─── .st XML parsing / serialization ─────────────────────────────────────────

interface StKey {
  id: string;
  languages: Record<string, string>;
}

interface StDocument {
  packageName: string;
  keys: StKey[];
}

function parseStFile(content: string): StDocument {
  const doc: StDocument = { packageName: "default", keys: [] };

  // Extract package name
  const pkgMatch = content.match(/<Package\s+Name="([^"]+)"/i);
  if (pkgMatch) {
    doc.packageName = pkgMatch[1];
  }

  // Extract keys: <Key Id="STR_X"><Original>text</Original></Key>
  // Also handle per-language tags: <Key Id="STR_X"><en_us>text</en_us></Key>
  const keyBlockRegex = /<Key\s+Id="([^"]+)"\s*>([\s\S]*?)<\/Key>/gi;
  let keyMatch: RegExpExecArray | null;
  while ((keyMatch = keyBlockRegex.exec(content)) !== null) {
    const keyId = keyMatch[1];
    const inner = keyMatch[2];
    const languages: Record<string, string> = {};

    // Check for <Original> tag (legacy/standard)
    const origMatch = inner.match(/<Original>([\s\S]*?)<\/Original>/i);
    if (origMatch) {
      languages["en_us"] = decodeXml(origMatch[1]);
    }

    // Check for per-language tags
    const langRegex = /<([a-z]{2}_[a-z]{2})>([\s\S]*?)<\/\1>/gi;
    let langMatch: RegExpExecArray | null;
    while ((langMatch = langRegex.exec(inner)) !== null) {
      languages[langMatch[1]] = decodeXml(langMatch[2]);
    }

    doc.keys.push({ id: keyId, languages });
  }

  return doc;
}

function serializeStFile(doc: StDocument): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push("<StringTable>");
  lines.push(`\t<Package Name="${escapeXml(doc.packageName)}">`);

  for (const key of doc.keys) {
    lines.push(`\t\t<Key Id="${escapeXml(key.id)}">`);
    const langKeys = Object.keys(key.languages);
    if (langKeys.length === 1 && langKeys[0] === "en_us") {
      lines.push(`\t\t\t<Original>${escapeXml(key.languages["en_us"])}</Original>`);
    } else {
      for (const [lang, value] of Object.entries(key.languages)) {
        lines.push(`\t\t\t<${lang}>${escapeXml(value)}</${lang}>`);
      }
    }
    lines.push("\t\t</Key>");
  }

  lines.push("\t</Package>");
  lines.push("</StringTable>");
  lines.push("");
  return lines.join("\n");
}

function decodeXml(str: string): string {
  return str
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── registerStringTable ──────────────────────────────────────────────────────

export function registerStringTable(server: McpServer, config: Config): void {
  server.registerTool(
    "string_table",
    {
      description:
        "Manage localization string tables (.st files) offline — scan for #STR_ keys, validate coverage, add/remove entries.",
      inputSchema: {
        action: z
          .enum(["scan", "validate", "add", "remove", "list"])
          .describe(
            "Action: scan (find all #STR_ refs in project), validate (check .st covers all refs), add (insert key), remove (delete key), list (show all keys)"
          ),
        projectPath: z
          .string()
          .describe("Mod project directory (absolute path)"),
        stPath: z
          .string()
          .optional()
          .describe("Path to .st file (required for add/remove/validate/list). Relative to projectPath or absolute."),
        key: z
          .string()
          .optional()
          .describe('String key like "STR_MYMOD_TITLE" (for add/remove). Omit the leading #.'),
        value: z
          .string()
          .optional()
          .describe("Localized text value (for add)"),
        language: z
          .string()
          .default("en_us")
          .optional()
          .describe("Language column (default: en_us)"),
      },
    },
    async ({ action, projectPath, stPath, key, value, language }) => {
      const lang = language ?? "en_us";

      // Validate projectPath exists
      if (!existsSync(projectPath)) {
        return {
          content: [{ type: "text", text: `Project directory not found: ${projectPath}` }],
          isError: true,
        };
      }

      // ── scan ──────────────────────────────────────────────────────────────
      if (action === "scan") {
        const referencedKeys = new Map<string, Set<string>>();

        walkFiles(projectPath, [".c", ".layout"], (filePath, relPath) => {
          const keys = extractKeysFromFile(filePath);
          for (const k of keys) {
            if (!referencedKeys.has(k)) {
              referencedKeys.set(k, new Set());
            }
            referencedKeys.get(k)!.add(relPath);
          }
        });

        // Find .st files and extract defined keys
        const definedKeys = new Set<string>();
        const stFiles: string[] = [];
        walkFiles(projectPath, [".st"], (filePath, relPath) => {
          stFiles.push(relPath);
          try {
            const content = readFileSync(filePath, "utf-8");
            const doc = parseStFile(content);
            for (const k of doc.keys) {
              definedKeys.add(k.id);
            }
          } catch {
            // skip unreadable
          }
        });

        const allReferenced = Array.from(referencedKeys.keys()).sort();
        const missing = allReferenced.filter((k) => !definedKeys.has(k));
        const unused = Array.from(definedKeys)
          .filter((k) => !referencedKeys.has(k))
          .sort();

        const lines: string[] = [];
        lines.push("## String Table Scan");
        lines.push("");
        lines.push(`**Project:** ${projectPath}`);
        lines.push(`**Referenced keys:** ${allReferenced.length}`);
        lines.push(`**Defined keys (in .st):** ${definedKeys.size}`);
        lines.push(`**.st files found:** ${stFiles.length}`);
        lines.push("");

        if (stFiles.length > 0) {
          lines.push("### .st Files");
          for (const f of stFiles) lines.push(`- ${f}`);
          lines.push("");
        }

        if (missing.length > 0) {
          lines.push(`### Missing Keys (${missing.length})`);
          lines.push("These keys are referenced in code but not defined in any .st file:");
          lines.push("");
          for (const k of missing) {
            const files = Array.from(referencedKeys.get(k)!);
            lines.push(`- **${k}**`);
            for (const f of files) lines.push(`    - ${f}`);
          }
          lines.push("");
        }

        if (unused.length > 0) {
          lines.push(`### Unused Keys (${unused.length})`);
          lines.push("These keys are defined in .st but not referenced in code:");
          lines.push("");
          for (const k of unused) lines.push(`- ${k}`);
          lines.push("");
        }

        if (missing.length === 0 && unused.length === 0) {
          lines.push("All referenced keys are defined and all defined keys are used.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── validate ──────────────────────────────────────────────────────────
      if (action === "validate") {
        if (!stPath) {
          return {
            content: [{ type: "text", text: "action='validate' requires 'stPath' parameter." }],
            isError: true,
          };
        }

        let resolvedStPath: string;
        try {
          resolvedStPath = validateProjectPath(projectPath, stPath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid stPath: ${msg}` }],
            isError: true,
          };
        }

        if (!existsSync(resolvedStPath)) {
          return {
            content: [{ type: "text", text: `.st file not found: ${stPath}` }],
            isError: true,
          };
        }

        // Parse the .st file
        let doc: StDocument;
        try {
          const content = readFileSync(resolvedStPath, "utf-8");
          doc = parseStFile(content);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Failed to parse .st file: ${msg}` }],
            isError: true,
          };
        }

        const definedKeys = new Set(doc.keys.map((k) => k.id));

        // Scan all project references
        const referencedKeys = new Map<string, Set<string>>();
        walkFiles(projectPath, [".c", ".layout"], (filePath, relPath) => {
          const keys = extractKeysFromFile(filePath);
          for (const k of keys) {
            if (!referencedKeys.has(k)) {
              referencedKeys.set(k, new Set());
            }
            referencedKeys.get(k)!.add(relPath);
          }
        });

        const missing = Array.from(referencedKeys.keys())
          .filter((k) => !definedKeys.has(k))
          .sort();

        const lines: string[] = [];
        lines.push(`## Validation: ${stPath}`);
        lines.push("");
        lines.push(`**Package:** ${doc.packageName}`);
        lines.push(`**Keys in .st:** ${doc.keys.length}`);
        lines.push(`**Keys referenced in project:** ${referencedKeys.size}`);
        lines.push("");

        if (missing.length > 0) {
          lines.push(`### Missing Keys (${missing.length})`);
          lines.push("These keys need to be added to the .st file:");
          lines.push("");
          for (const k of missing) {
            const files = Array.from(referencedKeys.get(k)!);
            lines.push(`- **${k}**`);
            for (const f of files) lines.push(`    - ${f}`);
          }
        } else {
          lines.push("All referenced keys are present in the .st file.");
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      // ── add ───────────────────────────────────────────────────────────────
      if (action === "add") {
        if (!stPath) {
          return {
            content: [{ type: "text", text: "action='add' requires 'stPath' parameter." }],
            isError: true,
          };
        }
        if (!key) {
          return {
            content: [{ type: "text", text: "action='add' requires 'key' parameter." }],
            isError: true,
          };
        }
        if (value === undefined) {
          return {
            content: [{ type: "text", text: "action='add' requires 'value' parameter." }],
            isError: true,
          };
        }

        const cleanKey = key.startsWith("#") ? key.slice(1) : key;

        let resolvedStPath: string;
        try {
          resolvedStPath = validateProjectPath(projectPath, stPath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid stPath: ${msg}` }],
            isError: true,
          };
        }

        let doc: StDocument;
        if (existsSync(resolvedStPath)) {
          try {
            const content = readFileSync(resolvedStPath, "utf-8");
            doc = parseStFile(content);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [{ type: "text", text: `Failed to parse existing .st file: ${msg}` }],
              isError: true,
            };
          }
        } else {
          // Create new .st file with package derived from filename
          const basename = resolvedStPath.split(/[\\/]/).pop()?.replace(/\.st$/i, "") ?? "default";
          doc = { packageName: basename, keys: [] };
        }

        // Check for duplicate
        const existing = doc.keys.find((k) => k.id === cleanKey);
        if (existing) {
          existing.languages[lang] = value;
        } else {
          doc.keys.push({ id: cleanKey, languages: { [lang]: value } });
        }

        // Ensure directory exists
        mkdirSync(dirname(resolvedStPath), { recursive: true });
        writeFileSync(resolvedStPath, serializeStFile(doc), "utf-8");

        const actionLabel = existing ? "Updated" : "Added";
        return {
          content: [
            {
              type: "text",
              text: `**${actionLabel} key:** ${cleanKey}\n**Language:** ${lang}\n**Value:** ${value}\n**File:** ${stPath}\n**Total keys in file:** ${doc.keys.length}`,
            },
          ],
        };
      }

      // ── remove ────────────────────────────────────────────────────────────
      if (action === "remove") {
        if (!stPath) {
          return {
            content: [{ type: "text", text: "action='remove' requires 'stPath' parameter." }],
            isError: true,
          };
        }
        if (!key) {
          return {
            content: [{ type: "text", text: "action='remove' requires 'key' parameter." }],
            isError: true,
          };
        }

        const cleanKey = key.startsWith("#") ? key.slice(1) : key;

        let resolvedStPath: string;
        try {
          resolvedStPath = validateProjectPath(projectPath, stPath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid stPath: ${msg}` }],
            isError: true,
          };
        }

        if (!existsSync(resolvedStPath)) {
          return {
            content: [{ type: "text", text: `.st file not found: ${stPath}` }],
            isError: true,
          };
        }

        let doc: StDocument;
        try {
          const content = readFileSync(resolvedStPath, "utf-8");
          doc = parseStFile(content);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Failed to parse .st file: ${msg}` }],
            isError: true,
          };
        }

        const idx = doc.keys.findIndex((k) => k.id === cleanKey);
        if (idx === -1) {
          return {
            content: [{ type: "text", text: `Key "${cleanKey}" not found in ${stPath}` }],
            isError: true,
          };
        }

        doc.keys.splice(idx, 1);
        writeFileSync(resolvedStPath, serializeStFile(doc), "utf-8");

        return {
          content: [
            {
              type: "text",
              text: `**Removed key:** ${cleanKey}\n**File:** ${stPath}\n**Remaining keys:** ${doc.keys.length}`,
            },
          ],
        };
      }

      // ── list ──────────────────────────────────────────────────────────────
      if (action === "list") {
        if (!stPath) {
          return {
            content: [{ type: "text", text: "action='list' requires 'stPath' parameter." }],
            isError: true,
          };
        }

        let resolvedStPath: string;
        try {
          resolvedStPath = validateProjectPath(projectPath, stPath);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Invalid stPath: ${msg}` }],
            isError: true,
          };
        }

        if (!existsSync(resolvedStPath)) {
          return {
            content: [{ type: "text", text: `.st file not found: ${stPath}` }],
            isError: true,
          };
        }

        let doc: StDocument;
        try {
          const content = readFileSync(resolvedStPath, "utf-8");
          doc = parseStFile(content);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [{ type: "text", text: `Failed to parse .st file: ${msg}` }],
            isError: true,
          };
        }

        if (doc.keys.length === 0) {
          return {
            content: [{ type: "text", text: `**String Table: ${stPath}**\n\nPackage: ${doc.packageName}\nNo keys defined.` }],
          };
        }

        const lines: string[] = [];
        lines.push(`## String Table: ${stPath}`);
        lines.push("");
        lines.push(`**Package:** ${doc.packageName}`);
        lines.push(`**Keys:** ${doc.keys.length}`);
        lines.push("");
        lines.push("| Key | en_us | Other Languages |");
        lines.push("|-----|-------|-----------------|");

        for (const k of doc.keys) {
          const enUs = k.languages["en_us"] ?? k.languages["Original"] ?? "";
          const otherLangs = Object.entries(k.languages)
            .filter(([l]) => l !== "en_us" && l !== "Original")
            .map(([l, v]) => `${l}: ${v}`)
            .join(", ");
          lines.push(`| ${k.id} | ${enUs} | ${otherLangs || "-"} |`);
        }

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      return {
        content: [{ type: "text", text: `Unknown action: ${action}` }],
        isError: true,
      };
    },
  );
}
