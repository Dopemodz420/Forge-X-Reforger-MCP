import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readFileSync, existsSync, statSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { PakVirtualFS } from "../pak/vfs.js";
import { resolveGameDataPath } from "../utils/game-paths.js";

const MAX_FILE_SIZE = 512_000;
const TEXT_EXTENSIONS = new Set([".conf"]);

const CONFIG_TYPE_ENUM = ["auto", "faction", "mission-header", "entity-catalog"] as const;

// ── Required fields per config type ──────────────────────────────────────────

const REQUIRED_FIELDS: Record<string, string[]> = {
  faction: ["m_sFactionKey", "m_aFactionFlags", "m_sFactionName"],
  "mission-header": ["worldName", "scenarioName"],
  "entity-catalog": [],
};

// ── Known numeric properties and their valid ranges ──────────────────────────

const NUMERIC_RANGES: Record<string, { min: number; max: number }> = {
  playercount: { min: 1, max: 256 },
  maxplayers: { min: 1, max: 256 },
  xp_multiplier: { min: 0, max: 10 },
  lifetime: { min: 0, max: 3600 },
  radius: { min: 0, max: 100000 },
};

// ── Resource path patterns ───────────────────────────────────────────────────

/** File extensions that are game resources worth validating */
const RESOURCE_EXTENSIONS = new Set([
  ".et", ".edds", ".png", ".layout", ".emat", ".ematinst",
  ".vmat", ".vmatinst", ".xob", ".p3d", ".conf",
]);

/**
 * Extract all string values that look like resource paths from conf content.
 * Handles both `Key = "path/to/resource.ext"` and GUID references `{GUID}path/to/resource.ext`.
 */
function extractResourcePaths(content: string): Array<{ path: string; line: number; raw: string }> {
  const results: Array<{ path: string; line: number; raw: string }> = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Match GUID-ref resource paths: "{XXXXXXXXXXXXXXXX}Some/Path/file.ext"
    const guidRefRe = /\{[0-9A-Fa-f]{16}\}([^\s";\}]+)/g;
    let m: RegExpExecArray | null;
    while ((m = guidRefRe.exec(line)) !== null) {
      const resourcePath = m[1];
      if (hasResourceExtension(resourcePath)) {
        results.push({ path: resourcePath, line: lineNum, raw: line.trim() });
      }
    }

    // Match bare string resource paths (not GUID refs — those handled above)
    // Look for quoted strings that contain path separators and resource extensions
    const barePathRe = /=\s*"([^"]+)"/g;
    while ((m = barePathRe.exec(line)) !== null) {
      const value = m[1];
      // Skip GUID-only strings
      if (/^\{[0-9A-Fa-f]{16}\}$/.test(value)) continue;
      // Skip strings that are GUID-ref prefixed (already captured)
      if (value.startsWith("{")) continue;
      // Skip obvious non-paths (no extension, no slash)
      if (hasResourceExtension(value) && value.includes("/")) {
        results.push({ path: value, line: lineNum, raw: line.trim() });
      }
    }
  }

  return results;
}

function hasResourceExtension(path: string): boolean {
  const ext = extname(path).toLowerCase();
  return RESOURCE_EXTENSIONS.has(ext);
}

// ── Enfusion conf parser (regex-based) ───────────────────────────────────────

interface ConfEntry {
  key: string;
  value: string;
  line: number;
}

interface ParseResult {
  entries: ConfEntry[];
  errors: string[];
  warnings: string[];
  /** Detected config type from class name or block structure */
  detectedType: string | null;
}

/**
 * Parse an Enfusion .conf file into key-value entries.
 * Handles nested blocks with `{ }`, comments `//`, and semicolons.
 */
function parseConf(content: string): ParseResult {
  const entries: ConfEntry[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  let detectedType: string | null = null;

  const lines = content.split("\n");
  let braceDepth = 0;
  let inComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) continue;

    // Handle block comments /* ... */
    if (inComment) {
      if (trimmed.includes("*/")) {
        inComment = false;
      }
      continue;
    }
    if (trimmed.startsWith("/*")) {
      if (!trimmed.includes("*/")) {
        inComment = true;
      }
      continue;
    }

    // Skip single-line comments
    if (trimmed.startsWith("//")) continue;

    // Track brace depth for block structure validation
    const openBraces = (trimmed.match(/\{/g) || []).length;
    const closeBraces = (trimmed.match(/\}/g) || []).length;
    braceDepth += openBraces - closeBraces;

    if (braceDepth < 0) {
      errors.push(`Line ${lineNum}: unexpected closing brace '}'`);
      braceDepth = 0;
    }

    // Detect class/type from top-level declarations like "class CampaignFaction"
    const classRe = /^\s*(?:class|enum)\s+(\w+)/;
    const classMatch = classRe.exec(trimmed);
    if (classMatch && braceDepth === 1) {
      const className = classMatch[1];
      if (className.includes("Faction")) detectedType = "faction";
      else if (className.includes("MissionHeader") || className.includes("MissionHeaderCampaign")) detectedType = "mission-header";
      else if (className.includes("Catalog") || className.includes("Category")) detectedType = "entity-catalog";
    }

    // Match key = value pairs (with optional semicolon)
    const kvRe = /^(\w+)\s*=\s*(.+?);?\s*$/;
    const kvMatch = kvRe.exec(trimmed);
    if (kvMatch) {
      const key = kvMatch[1];
      let value = kvMatch[2].trim();
      // Strip trailing semicolon if present
      if (value.endsWith(";")) value = value.slice(0, -1).trim();
      entries.push({ key, value, line: lineNum });
    }
  }

  // Final brace balance check
  if (braceDepth !== 0) {
    errors.push(`Unbalanced braces: depth is ${braceDepth} at end of file`);
  }

  return { entries, errors, warnings, detectedType };
}

// ── Validation logic ─────────────────────────────────────────────────────────

interface ResourcePathIssue {
  path: string;
  line: number;
  raw: string;
  suggestions: string[];
}

interface ValidationResult {
  parseValid: boolean;
  parseErrors: string[];
  parseWarnings: string[];
  detectedType: string | null;
  resourceIssues: ResourcePathIssue[];
  missingFields: string[];
  invalidGuids: Array<{ value: string; line: number }>;
  rangeIssues: Array<{ key: string; value: number; range: { min: number; max: number }; line: number }>;
  entryCount: number;
}

function validateConfig(
  content: string,
  requestedType: string,
  config: Config
): ValidationResult {
  const parse = parseConf(content);

  // Determine config type
  const configType = requestedType === "auto" ? parse.detectedType : requestedType;

  // Validate resource paths
  const resourcePaths = extractResourcePaths(content);
  const pakVfs = PakVirtualFS.get(config.gamePath);
  const gameDataPath = resolveGameDataPath(config.gamePath);
  const resourceIssues: ResourcePathIssue[] = [];

  for (const rp of resourcePaths) {
    let found = false;

    // Check project directory first
    if (config.projectPath) {
      try {
        const fullPath = resolve(config.projectPath, rp.path);
        if (existsSync(fullPath)) {
          found = true;
        }
      } catch {
        // ignore
      }
    }

    // Check game data loose files
    if (!found && gameDataPath) {
      try {
        const fullPath = resolve(gameDataPath, rp.path);
        if (existsSync(fullPath)) {
          found = true;
        }
      } catch {
        // ignore
      }
    }

    // Check pak VFS
    if (!found && pakVfs) {
      found = pakVfs.exists(rp.path);
    }

    if (!found) {
      // Find fuzzy suggestions
      const suggestions = findResourceSuggestions(rp.path, pakVfs, config);
      resourceIssues.push({ path: rp.path, line: rp.line, raw: rp.raw, suggestions });
    }
  }

  // Validate required fields
  const missingFields: string[] = [];
  if (configType && REQUIRED_FIELDS[configType]) {
    const required = REQUIRED_FIELDS[configType];
    const entryKeys = new Set(parse.entries.map((e) => e.key));
    for (const field of required) {
      if (!entryKeys.has(field)) {
        missingFields.push(field);
      }
    }
  }

  // For entity-catalog, check for at least one prefab reference
  if (configType === "entity-catalog") {
    const hasPrefab = parse.entries.some(
      (e) =>
        e.key.toLowerCase().includes("prefab") ||
        (e.value.includes("{") && e.value.includes("}"))
    );
    if (!hasPrefab) {
      missingFields.push("(at least one prefab reference)");
    }
  }

  // Validate GUID format
  const invalidGuids: Array<{ value: string; line: number }> = [];
  const guidRe = /\{([0-9A-Fa-f]*)\}/g;
  for (const entry of parse.entries) {
    let m: RegExpExecArray | null;
    const valRe = /\{([0-9A-Fa-f]*)\}/g;
    while ((m = valRe.exec(entry.value)) !== null) {
      const hex = m[1];
      if (hex.length !== 16) {
        invalidGuids.push({ value: m[0], line: entry.line });
      }
    }
  }

  // Also scan raw content for GUIDs not captured in key-value parsing
  const rawGuidRe = /\{([0-9A-Fa-f]*)\}/g;
  const contentLines = content.split("\n");
  const seenGuidLines = new Set(invalidGuids.map((g) => g.line));
  for (let i = 0; i < contentLines.length; i++) {
    if (seenGuidLines.has(i + 1)) continue;
    let m: RegExpExecArray | null;
    while ((m = rawGuidRe.exec(contentLines[i])) !== null) {
      const hex = m[1];
      if (hex.length !== 16) {
        invalidGuids.push({ value: m[0], line: i + 1 });
      }
    }
  }

  // Validate numeric ranges
  const rangeIssues: Array<{
    key: string;
    value: number;
    range: { min: number; max: number };
    line: number;
  }> = [];

  for (const entry of parse.entries) {
    const rangeKey = entry.key.toLowerCase();
    const range = NUMERIC_RANGES[rangeKey];
    if (range) {
      const num = Number(entry.value);
      if (!isNaN(num) && (num < range.min || num > range.max)) {
        rangeIssues.push({ key: entry.key, value: num, range, line: entry.line });
      }
    }
  }

  return {
    parseValid: parse.errors.length === 0,
    parseErrors: parse.errors,
    parseWarnings: parse.warnings,
    detectedType: parse.detectedType,
    resourceIssues,
    missingFields,
    invalidGuids,
    rangeIssues,
    entryCount: parse.entries.length,
  };
}

/**
 * Find similar resource paths in the VFS for suggestions.
 */
function findResourceSuggestions(
  targetPath: string,
  pakVfs: PakVirtualFS | null,
  config: Config
): string[] {
  const filename = targetPath.split("/").pop()?.toLowerCase() ?? "";
  const basename = filename.replace(/\.[^.]+$/, "");
  if (!basename) return [];

  if (pakVfs) {
    const matches = pakVfs.searchFiles(basename, 5);
    return matches
      .filter((m) => m.toLowerCase() !== targetPath.toLowerCase())
      .slice(0, 3);
  }

  return [];
}

// ── Format output ────────────────────────────────────────────────────────────

function formatResults(filePath: string, result: ValidationResult): string {
  const lines: string[] = [];
  const fileName = filePath.split(/[\\/]/).pop() ?? filePath;

  lines.push(`## Config Validation: ${fileName}`);
  lines.push("");

  // Parse status
  lines.push("### Parse Status");
  if (result.parseValid) {
    lines.push("✅ Valid Enfusion text format");
  } else {
    lines.push("❌ Parse errors found:");
    for (const err of result.parseErrors) {
      lines.push(`  - ${err}`);
    }
  }
  lines.push("");

  // Detected type
  if (result.detectedType) {
    lines.push(`**Detected type:** ${result.detectedType}`);
  } else {
    lines.push("**Detected type:** _(could not auto-detect)_");
  }
  lines.push(`**Entries parsed:** ${result.entryCount}`);
  lines.push("");

  // Resource paths
  lines.push(`### Resource Paths (${result.resourceIssues.length} issue${result.resourceIssues.length !== 1 ? "s" : ""})`);
  if (result.resourceIssues.length === 0) {
    lines.push("✅ All resource paths valid or none found");
  } else {
    for (const issue of result.resourceIssues) {
      lines.push(`❌ Resource path not found: "${issue.path}"`);
      lines.push(`  Line ${issue.line}: ${issue.raw}`);
      if (issue.suggestions.length > 0) {
        lines.push(`  Similar resources found:`);
        for (const s of issue.suggestions) {
          lines.push(`    - ${s}`);
        }
      }
    }
  }
  lines.push("");

  // Required fields
  lines.push(`### Required Fields (${result.missingFields.length} missing)`);
  if (result.missingFields.length === 0) {
    lines.push("✅ All required fields present");
  } else {
    for (const field of result.missingFields) {
      lines.push(`❌ Missing required field: ${field}`);
    }
  }
  lines.push("");

  // GUID format
  lines.push(`### GUID Format (${result.invalidGuids.length} invalid)`);
  if (result.invalidGuids.length === 0) {
    lines.push("✅ All GUIDs valid (16 hex chars in {XXXXXXXXXXXXXXXX} format)");
  } else {
    for (const g of result.invalidGuids) {
      lines.push(`❌ Invalid GUID at line ${g.line}: ${g.value} (expected 16 hex chars)`);
    }
  }
  lines.push("");

  // Value ranges
  if (result.rangeIssues.length > 0) {
    lines.push(`### Value Ranges (${result.rangeIssues.length} issue${result.rangeIssues.length !== 1 ? "s" : ""})`);
    for (const r of result.rangeIssues) {
      lines.push(
        `❌ ${r.key} = ${r.value} is outside valid range [${r.range.min}–${r.range.max}] (line ${r.line})`
      );
    }
    lines.push("");
  }

  // Summary
  lines.push("### Summary");
  lines.push(`- Parse: ${result.parseValid ? "valid" : "invalid"}`);
  lines.push(`- ${result.resourceIssues.length} missing resource path${result.resourceIssues.length !== 1 ? "s" : ""}`);
  lines.push(`- ${result.missingFields.length} missing required field${result.missingFields.length !== 1 ? "s" : ""}`);
  lines.push(`- ${result.invalidGuids.length} invalid GUID${result.invalidGuids.length !== 1 ? "s" : ""}`);
  if (result.rangeIssues.length > 0) {
    lines.push(`- ${result.rangeIssues.length} out-of-range value${result.rangeIssues.length !== 1 ? "s" : ""}`);
  }

  const hasIssues =
    !result.parseValid ||
    result.resourceIssues.length > 0 ||
    result.missingFields.length > 0 ||
    result.invalidGuids.length > 0 ||
    result.rangeIssues.length > 0;

  if (!hasIssues) {
    lines.push("");
    lines.push("✅ Config passes all validation checks.");
  }

  return lines.join("\n");
}

// ── Tool registration ────────────────────────────────────────────────────────

export function registerConfigValidate(server: McpServer, config: Config): void {
  server.registerTool(
    "config_validate",
    {
      description:
        "Perform semantic validation of Enfusion .conf files — checks parse validity, " +
        "resource path existence, required fields by config type, GUID format, and numeric value ranges. " +
        "Reports missing resources with suggestions for similar files.",
      inputSchema: {
        configPath: z
          .string()
          .min(1)
          .describe(
            "Relative path to the .conf file (e.g., 'Configs/MyFaction.conf')"
          ),
        projectPath: z
          .string()
          .optional()
          .describe("Mod project directory. Uses configured default if omitted."),
        type: z
          .enum(CONFIG_TYPE_ENUM)
          .default("auto")
          .describe(
            "Config type for required field validation. 'auto' attempts to detect from class names. " +
            "'faction' checks faction fields. 'mission-header' checks scenario fields. " +
            "'entity-catalog' checks for prefab references."
          ),
      },
    },
    async ({ configPath, projectPath, type }) => {
      const basePath = projectPath || config.projectPath;

      // Path traversal guard
      if (configPath.includes("..")) {
        return {
          content: [
            { type: "text", text: "Path traversal not allowed: '..' segments are blocked" },
          ],
          isError: true,
        };
      }

      const ext = extname(configPath).toLowerCase();
      if (ext !== ".conf") {
        return {
          content: [
            { type: "text", text: `Expected a .conf file, got: ${ext}` },
          ],
          isError: true,
        };
      }

      // Read the file
      let content: string | null = null;
      let resolvedPath = configPath;

      // Try project directory
      if (basePath) {
        try {
          const fullPath = validateProjectPath(basePath, configPath);
          if (existsSync(fullPath)) {
            const stats = statSync(fullPath);
            if (stats.isFile() && stats.size <= MAX_FILE_SIZE) {
              content = readFileSync(fullPath, "utf-8");
              resolvedPath = fullPath;
            }
          }
        } catch {
          // path traversal or read error — skip
        }
      }

      // Try game data loose files
      if (content === null) {
        const gameDataPath = resolveGameDataPath(config.gamePath);
        if (gameDataPath) {
          try {
            const fullPath = resolve(gameDataPath, configPath);
            if (existsSync(fullPath)) {
              const stats = statSync(fullPath);
              if (stats.isFile() && stats.size <= MAX_FILE_SIZE) {
                content = readFileSync(fullPath, "utf-8");
                resolvedPath = fullPath;
              }
            }
          } catch {
            // ignore
          }
        }
      }

      // Try pak VFS
      if (content === null) {
        const pakVfs = PakVirtualFS.get(config.gamePath);
        if (pakVfs && pakVfs.exists(configPath)) {
          const fileSize = pakVfs.fileSize(configPath);
          if (fileSize <= MAX_FILE_SIZE) {
            content = pakVfs.readTextFile(configPath);
            resolvedPath = configPath;
          }
        }
      }

      if (content === null) {
        return {
          content: [
            {
              type: "text",
              text:
                `Config file not found: ${configPath}\n\n` +
                `Searched in:\n` +
                `- Project: ${basePath ?? "(not configured)"}\n` +
                `- Game data: ${config.gamePath}\n\n` +
                `Tip: Use project_browse or game_search to find the correct path.`,
            },
          ],
          isError: true,
        };
      }

      // Validate
      try {
        const result = validateConfig(content, type, config);
        const output = formatResults(resolvedPath, result);

        const hasIssues =
          !result.parseValid ||
          result.resourceIssues.length > 0 ||
          result.missingFields.length > 0 ||
          result.invalidGuids.length > 0 ||
          result.rangeIssues.length > 0;

        return {
          content: [{ type: "text", text: output }],
          isError: hasIssues,
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Validation error: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
