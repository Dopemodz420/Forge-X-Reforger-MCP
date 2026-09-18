import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import {
  join,
  extname,
  relative,
  basename,
  resolve,
} from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { formatSize } from "../utils/dir-listing.js";
import { parse, getProperty } from "../formats/enfusion-text.js";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ValidationIssue {
  level: "error" | "warning" | "info";
  message: string;
}

interface ValidationSection {
  name: string;
  status: "pass" | "warn" | "fail";
  items: string[];
}

interface ExportResult {
  projectName: string;
  sections: ValidationSection[];
  issues: ValidationIssue[];
  hasErrors: boolean;
}

// ─── File helpers ────────────────────────────────────────────────────────────

function findFiles(dir: string, ext: string): string[] {
  const results: string[] = [];
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
          results.push(fullPath);
        }
      }
    } catch {
      // Skip directories we can't read
    }
  };
  walk(dir);
  return results;
}

function walkAllFiles(
  dir: string,
  basePath: string,
  callback: (fullPath: string, relPath: string) => void
): void {
  if (!existsSync(dir)) return;
  const walk = (current: string) => {
    try {
      const entries = readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith(".")) continue;
        const fullPath = join(current, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else {
          callback(fullPath, relative(basePath, fullPath).replace(/\\/g, "/"));
        }
      }
    } catch {
      // Skip
    }
  };
  walk(dir);
}

// ─── Validation checks ──────────────────────────────────────────────────────

function validateStructure(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  // addon.gproj
  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) {
    items.push("addon.gproj: MISSING (error)");
    status = "fail";
  } else if (gprojFiles.length > 1) {
    items.push(`Multiple .gproj files: ${gprojFiles.join(", ")} (warning)`);
    status = "warn";
  } else {
    items.push(`addon.gproj: present (${gprojFiles[0]})`);
  }

  // thumbnail.png
  const thumbPath = join(projectPath, "thumbnail.png");
  if (existsSync(thumbPath)) {
    try {
      const size = statSync(thumbPath).size;
      items.push(`thumbnail.png: present (${formatSize(size)})`);
    } catch {
      items.push("thumbnail.png: present (size unknown)");
    }
  } else {
    items.push("thumbnail.png: MISSING (warning — required for Workshop)");
    if (status === "pass") status = "warn";
  }

  // README.md
  const readmePath = join(projectPath, "README.md");
  if (existsSync(readmePath)) {
    items.push("README.md: present");
  } else {
    items.push("README.md: not found (info)");
  }

  return { name: "Structure", status, items };
}

function validateGproj(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  if (gprojFiles.length === 0) {
    return { name: "Addon Project", status: "fail", items: ["No .gproj file found"] };
  }

  const filename = gprojFiles[0];
  const filepath = join(projectPath, filename);
  try {
    const content = readFileSync(filepath, "utf-8");
    const node = parse(content);

    // Root type
    if (node.type !== "GameProject") {
      items.push(`Root type: "${node.type}" (expected GameProject)`);
      status = "fail";
    } else {
      items.push("Root type: GameProject");
    }

    // ID
    const id = getProperty(node, "ID");
    if (!id) {
      items.push("ID field: MISSING (error)");
      status = "fail";
    } else {
      items.push(`ID: ${id}`);
    }

    // GUID
    const guid = getProperty(node, "GUID");
    if (!guid) {
      items.push("GUID field: MISSING (error)");
      status = "fail";
    } else if (typeof guid === "string" && !/^[0-9A-Fa-f]{16}$/.test(guid)) {
      items.push(`GUID: ${guid} (warning — not valid 16-char hex)`);
      if (status === "pass") status = "warn";
    } else {
      items.push(`GUID: ${guid}`);
    }

    // Dependencies
    const deps = node.children.find((c) => c.type === "Dependencies");
    if (!deps) {
      items.push("Dependencies block: MISSING (error — mod won't load)");
      status = "fail";
    } else if (!deps.values.includes("58D0FB3206B6F859")) {
      items.push("Base game dependency (58D0FB3206B6F859): MISSING (error)");
      status = "fail";
    } else {
      items.push(`Dependencies: ${deps.values.length} entries (base game OK)`);
    }

    // Modules
    const modules = node.children.find((c) => c.type === "Modules");
    if (modules) {
      items.push(`Modules: ${modules.values.length} entries`);
    } else {
      items.push("Modules block: not found (warning)");
      if (status === "pass") status = "warn";
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    items.push(`Failed to parse: ${msg}`);
    status = "fail";
  }

  return { name: "Addon Project", status, items };
}

function validateScripts(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const allScripts = findFiles(projectPath, ".c");
  items.push(`Scripts: ${allScripts.length} files`);

  const invalidScripts: string[] = [];
  const misplacedScripts: string[] = [];

  for (const scriptPath of allScripts) {
    const rel = relative(projectPath, scriptPath).replace(/\\/g, "/");

    // Check module folder
    if (
      !rel.startsWith("Scripts/Game/") &&
      !rel.startsWith("Scripts/GameLib/") &&
      !rel.startsWith("Scripts/WorkbenchGame/")
    ) {
      misplacedScripts.push(rel);
    }

    // Check for class declaration
    try {
      const content = readFileSync(scriptPath, "utf-8");
      if (content.trim().length === 0) {
        invalidScripts.push(rel);
      } else {
        const hasClass = /\b(class|modded\s+class)\s+\w+/.test(content);
        if (!hasClass) {
          invalidScripts.push(rel);
        }
      }
    } catch {
      invalidScripts.push(rel);
    }
  }

  if (misplacedScripts.length > 0) {
    items.push(`${misplacedScripts.length} script(s) outside valid module folders: ${misplacedScripts.slice(0, 3).join(", ")}${misplacedScripts.length > 3 ? "..." : ""}`);
    status = "fail";
  }
  if (invalidScripts.length > 0) {
    items.push(`${invalidScripts.length} script(s) with no class declaration or empty: ${invalidScripts.slice(0, 3).join(", ")}${invalidScripts.length > 3 ? "..." : ""}`);
    if (status === "pass") status = "warn";
  }
  if (misplacedScripts.length === 0 && invalidScripts.length === 0 && allScripts.length > 0) {
    items.push("All scripts have valid class declarations");
  }

  return { name: "Scripts", status, items };
}

function validatePrefabs(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const allPrefabs = findFiles(projectPath, ".et");
  items.push(`Prefabs: ${allPrefabs.length} files`);

  const invalidPrefabs: string[] = [];

  for (const prefabPath of allPrefabs) {
    const rel = relative(projectPath, prefabPath).replace(/\\/g, "/");
    try {
      const content = readFileSync(prefabPath, "utf-8");
      parse(content);
    } catch {
      invalidPrefabs.push(rel);
    }
  }

  if (invalidPrefabs.length > 0) {
    items.push(`${invalidPrefabs.length} prefab(s) with invalid format: ${invalidPrefabs.slice(0, 3).join(", ")}${invalidPrefabs.length > 3 ? "..." : ""}`);
    status = "fail";
  } else if (allPrefabs.length > 0) {
    items.push("All prefabs parse correctly");
  }

  // Check for empty prefabs
  const emptyPrefabs: string[] = [];
  for (const prefabPath of allPrefabs) {
    const rel = relative(projectPath, prefabPath).replace(/\\/g, "/");
    try {
      const stat = statSync(prefabPath);
      if (stat.size < 50) {
        emptyPrefabs.push(rel);
      }
    } catch { /* skip */ }
  }
  if (emptyPrefabs.length > 0) {
    items.push(`${emptyPrefabs.length} empty/placeholder prefab(s): ${emptyPrefabs.slice(0, 3).join(", ")}${emptyPrefabs.length > 3 ? "..." : ""}`);
    if (status === "pass") status = "warn";
  }

  return { name: "Prefabs", status, items };
}

function validateConfigs(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const allConfigs = findFiles(projectPath, ".conf");
  items.push(`Configs: ${allConfigs.length} files`);

  const invalidConfigs: string[] = [];

  for (const configPath of allConfigs) {
    const rel = relative(projectPath, configPath).replace(/\\/g, "/");
    try {
      const content = readFileSync(configPath, "utf-8");
      parse(content);
    } catch {
      invalidConfigs.push(rel);
    }
  }

  if (invalidConfigs.length > 0) {
    items.push(`${invalidConfigs.length} config(s) with invalid format: ${invalidConfigs.slice(0, 3).join(", ")}${invalidConfigs.length > 3 ? "..." : ""}`);
    status = "fail";
  } else if (allConfigs.length > 0) {
    items.push("All configs parse correctly");
  }

  return { name: "Configs", status, items };
}

function validateGUIDs(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const guidMap = new Map<string, string[]>(); // guid -> files that define it

  // Scan .et, .conf, .layout files for component/instance GUIDs
  const scanExtensions = [".et", ".conf", ".layout"];
  for (const ext of scanExtensions) {
    const files = findFiles(projectPath, ext);
    for (const filePath of files) {
      const rel = relative(projectPath, filePath).replace(/\\/g, "/");
      try {
        const content = readFileSync(filePath, "utf-8");

        // Match quoted GUIDs that appear as IDs: SomeType "{GUID}" {
        const guidRegex = /"[{(]([0-9A-Fa-f]{16})[})]"/g;
        let match;
        while ((match = guidRegex.exec(content)) !== null) {
          const guid = match[1].toUpperCase();
          const existing = guidMap.get(guid) ?? [];
          if (!existing.includes(rel)) {
            existing.push(rel);
            guidMap.set(guid, existing);
          }
        }

        // Also match bare GUIDs in resource refs: {GUID}path/to/file
        const resRefRegex = /\{([0-9A-Fa-f]{16})\}/g;
        while ((match = resRefRegex.exec(content)) !== null) {
          const guid = match[1].toUpperCase();
          const existing = guidMap.get(guid) ?? [];
          if (!existing.includes(rel)) {
            existing.push(rel);
            guidMap.set(guid, existing);
          }
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  // Also extract GUID from addon.gproj
  const gprojFiles = readdirSync(projectPath).filter(
    (f) => extname(f).toLowerCase() === ".gproj"
  );
  for (const filename of gprojFiles) {
    try {
      const content = readFileSync(join(projectPath, filename), "utf-8");
      const node = parse(content);
      const guid = getProperty(node, "GUID");
      if (typeof guid === "string") {
        const upperGuid = guid.toUpperCase();
        const existing = guidMap.get(upperGuid) ?? [];
        if (!existing.includes(filename)) {
          existing.push(filename);
          guidMap.set(upperGuid, existing);
        }
      }
    } catch { /* skip */ }
  }

  items.push(`${guidMap.size} unique GUIDs found`);

  // More precise: scan .et files for component GUIDs (IDs after type name)
  const componentGUIDs = new Map<string, string[]>();
  const etFiles = findFiles(projectPath, ".et");
  for (const filePath of etFiles) {
    const rel = relative(projectPath, filePath).replace(/\\/g, "/");
    try {
      const content = readFileSync(filePath, "utf-8");
      // Match: TypeName GUID { — component ID pattern
      const compGuidRegex = /^\s*([A-Z]\w+)(?:\s+(\w+))?\s+"[{"']([0-9A-Fa-f]{16})[}"']"/gm;
      let match;
      while ((match = compGuidRegex.exec(content)) !== null) {
        const guid = match[3].toUpperCase();
        const existing = componentGUIDs.get(guid) ?? [];
        existing.push(rel);
        componentGUIDs.set(guid, existing);
      }
    } catch { /* skip */ }
  }

  // Check for duplicate component GUIDs (same GUID used as component ID in multiple files)
  const dupList: Array<{ guid: string; files: string[] }> = [];
  componentGUIDs.forEach((files, guid) => {
    const uniqueFiles = Array.from(new Set(files));
    if (uniqueFiles.length > 1) {
      dupList.push({ guid, files: uniqueFiles });
    }
  });

  if (dupList.length > 0) {
    items.push(`${dupList.length} duplicate component GUID(s) across files`);
    for (const dup of dupList.slice(0, 5)) {
      items.push(`  ${dup.guid}: ${dup.files.join(", ")}`);
    }
    status = "fail";
  } else {
    items.push("No duplicate component GUIDs detected");
  }

  return { name: "GUIDs", status, items };
}

function validateLocalization(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const keysReferenced = new Set<string>();
  const keysDefined = new Set<string>();

  // Scan .c and .layout files for #STR_ references
  const refExtensions = [".c", ".layout"];
  for (const ext of refExtensions) {
    const files = findFiles(projectPath, ext);
    for (const filePath of files) {
      try {
        const content = readFileSync(filePath, "utf-8");
        const refRegex = /#(STR_[A-Z0-9_]+)/g;
        let match;
        while ((match = refRegex.exec(content)) !== null) {
          keysReferenced.add(match[1]);
        }
      } catch { /* skip */ }
    }
  }

  // Scan .st files for defined keys
  const stFiles = findFiles(projectPath, ".st");
  for (const filePath of stFiles) {
    try {
      const content = readFileSync(filePath, "utf-8");
      // CSV format: "KEY","Value"
      const keyRegex = /^"(STR_[A-Z0-9_]+)"/gm;
      let match;
      while ((match = keyRegex.exec(content)) !== null) {
        keysDefined.add(match[1]);
      }
    } catch { /* skip */ }
  }

  items.push(`${keysReferenced.size} #STR_ keys referenced in code/layouts`);
  items.push(`${keysDefined.size} keys defined in .st files`);

  if (keysReferenced.size === 0) {
    items.push("No localization keys referenced (info)");
    if (status === "pass") status = "warn";
  } else {
    const missing = Array.from(keysReferenced).filter(
      (key) => !keysDefined.has(key)
    );
    const coverage = keysReferenced.size > 0
      ? ((keysReferenced.size - missing.length) / keysReferenced.size * 100).toFixed(0)
      : "100";

    if (missing.length > 0) {
      items.push(`${missing.length} missing key(s) in .st files: ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "..." : ""}`);
      items.push(`Coverage: ${coverage}%`);
      status = "fail";
    } else {
      items.push(`Coverage: ${coverage}%`);
    }
  }

  if (stFiles.length === 0 && keysReferenced.size > 0) {
    items.push("WARNING: No .st files found but #STR_ keys are referenced");
    status = "fail";
  }

  return { name: "Localization", status, items };
}

function validateLayouts(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  const layoutFiles = findFiles(projectPath, ".layout");
  items.push(`Layouts: ${layoutFiles.length} files`);

  const widgetClasses = [
    "FrameWidget", "TextWidget", "ImageWidget", "ButtonWidget",
    "EditBoxWidget", "CheckBoxWidget", "SliderWidget", "ProgressBarWidget",
    "VerticalLayoutWidget", "HorizontalLayoutWidget", "GridLayoutWidget",
    "OverlayWidget", "ScrollLayoutWidget", "SizeLayoutWidget", "SpacerWidget",
    "RichTextWidget", "ComboBoxWidget", "XComboBoxWidget",
    "MultilineEditBoxWidget", "MapWidget", "CanvasWidget",
  ];

  let totalUnnamed = 0;
  let totalNamed = 0;

  for (const filePath of layoutFiles) {
    const rel = relative(projectPath, filePath).replace(/\\/g, "/");
    try {
      const content = readFileSync(filePath, "utf-8");

      // Check for Name attributes
      const nameRegex = /Name\s+"([^"]+)"/g;
      let namedCount = 0;
      let match;
      while ((match = nameRegex.exec(content)) !== null) {
        namedCount++;
      }

      // Count widget instantiations
      let widgetCount = 0;
      for (const widgetClass of widgetClasses) {
        const widgetRegex = new RegExp(`${widgetClass}\\s*(?:\\(|{)`, "g");
        while ((widgetRegex.exec(content)) !== null) {
          widgetCount++;
        }
      }

      totalNamed += namedCount;
      totalUnnamed += Math.max(0, widgetCount - namedCount);

      // Check for empty layouts
      if (widgetCount === 0 && content.trim().length > 0) {
        items.push(`${rel}: no widgets found (warning)`);
        if (status === "pass") status = "warn";
      }
    } catch {
      items.push(`${rel}: could not read file (warning)`);
      if (status === "pass") status = "warn";
    }
  }

  if (layoutFiles.length > 0) {
    items.push(`${totalNamed} named widget(s), ${totalUnnamed} unnamed widget(s)`);
    if (totalUnnamed > 0 && totalNamed > 0) {
      const ratio = (totalUnnamed / (totalNamed + totalUnnamed) * 100).toFixed(0);
      items.push(`${ratio}% of widgets are unnamed`);
      if (totalUnnamed > 10 && status === "pass") status = "warn";
    }
  }

  return { name: "Layouts", status, items };
}

function validateResourcePaths(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "fail" = "pass";

  // Check for resource path references that point to non-existent local files
  const allFiles: string[] = [];
  walkAllFiles(projectPath, projectPath, (fp) => allFiles.push(fp));

  const localPathRefs: string[] = [];
  const brokenRefs: string[] = [];

  for (const filePath of allFiles) {
    const ext = extname(filePath).toLowerCase();
    if (![".c", ".et", ".conf", ".layout"].includes(ext)) continue;

    try {
      const content = readFileSync(filePath, "utf-8");
      const rel = relative(projectPath, filePath).replace(/\\/g, "/");

      // Match resource paths like "{GUID}/path/to/file.ext"
      const resRefRegex = /\{[0-9A-Fa-f]{16}\}([^\s"{}()]+\.(?:et|layout|conf|edds|emat|fnt|imageset|xob))/g;
      let match;
      while ((match = resRefRegex.exec(content)) !== null) {
        const resPath = match[1];
        // Skip game paths (we only check local mod paths)
        if (resPath.startsWith("Prefabs/") || resPath.startsWith("UI/") || resPath.startsWith("Scripts/")) {
          const fullPath = resolve(projectPath, resPath);
          if (!existsSync(fullPath)) {
            // Could be a game path, not necessarily broken — only flag if file is in project
            if (rel.startsWith("Prefabs/") || rel.startsWith("UI/") || rel.startsWith("Scripts/")) {
              brokenRefs.push(`${rel} → ${resPath}`);
            }
          }
        }
      }
    } catch { /* skip */ }
  }

  if (brokenRefs.length > 0) {
    items.push(`${brokenRefs.length} resource path(s) not found locally:`);
    for (const ref of brokenRefs.slice(0, 5)) {
      items.push(`  ${ref}`);
    }
    if (brokenRefs.length > 5) {
      items.push(`  ... and ${brokenRefs.length - 5} more`);
    }
    if (status === "pass") status = "warn";
  } else {
    items.push("All local resource path references resolve");
  }

  return { name: "Resource Paths", status, items };
}

function validatePlaceholders(projectPath: string): ValidationSection {
  const items: string[] = [];
  let status: "pass" | "warn" | "info" = "pass";

  const emptyFiles: string[] = [];
  const largeFiles: Array<{ file: string; size: number }> = [];

  walkAllFiles(projectPath, projectPath, (fullPath, relPath) => {
    try {
      const stat = statSync(fullPath);
      if (stat.size === 0) {
        emptyFiles.push(relPath);
      } else if (stat.size > 500 * 1024) {
        largeFiles.push({ file: relPath, size: stat.size });
      }
    } catch { /* skip */ }
  });

  if (emptyFiles.length > 0) {
    items.push(`${emptyFiles.length} empty file(s) (0 bytes): ${emptyFiles.slice(0, 3).join(", ")}${emptyFiles.length > 3 ? "..." : ""}`);
    if (status === "pass") status = "warn";
  }

  if (largeFiles.length > 0) {
    const sorted = largeFiles.sort((a, b) => b.size - a.size);
    items.push(`${sorted.length} large file(s) (>500 KB):`);
    for (const f of sorted.slice(0, 3)) {
      items.push(`  ${f.file} (${formatSize(f.size)})`);
    }
    if (sorted.length > 3) {
      items.push(`  ... and ${sorted.length - 3} more`);
    }
    if (status === "pass") status = "warn";
  }

  if (emptyFiles.length === 0 && largeFiles.length === 0) {
    items.push("No empty or oversized files detected");
  }

  return { name: "Placeholders", status, items };
}

// ─── Main validation runner ──────────────────────────────────────────────────

function runValidation(projectPath: string): ExportResult {
  const projectName = basename(projectPath);
  const sections: ValidationSection[] = [];
  const issues: ValidationIssue[] = [];

  sections.push(validateStructure(projectPath));
  sections.push(validateGproj(projectPath));
  sections.push(validateScripts(projectPath));
  sections.push(validatePrefabs(projectPath));
  sections.push(validateConfigs(projectPath));
  sections.push(validateGUIDs(projectPath));
  sections.push(validateLocalization(projectPath));
  sections.push(validateLayouts(projectPath));
  sections.push(validateResourcePaths(projectPath));
  sections.push(validatePlaceholders(projectPath));

  // Collect issues from sections
  for (const section of sections) {
    for (const item of section.items) {
      const lower = item.toLowerCase();
      let level: "error" | "warning" | "info" = "info";
      if (lower.includes("error") || lower.includes("missing") || lower.includes("invalid")) {
        level = "error";
      } else if (lower.includes("warning") || lower.includes("not found") || lower.includes("could not")) {
        level = "warning";
      }
      issues.push({ level, message: `[${section.name}] ${item}` });
    }
  }

  const hasErrors = sections.some((s) => s.status === "fail");

  return { projectName, sections, issues, hasErrors };
}

// ─── Report formatter ────────────────────────────────────────────────────────

function formatValidationReport(result: ExportResult): string {
  const lines: string[] = [];

  lines.push(`## Export Validation: ${result.projectName}`);
  lines.push("");

  const statusIcon = (s: "pass" | "warn" | "fail") => {
    switch (s) {
      case "pass": return "✅";
      case "warn": return "⚠️";
      case "fail": return "❌";
    }
  };

  for (const section of result.sections) {
    lines.push(`### ${section.name} ${statusIcon(section.status)}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
    lines.push("");
  }

  // Issues summary
  const errors = result.issues.filter((i) => i.level === "error");
  const warnings = result.issues.filter((i) => i.level === "warning");
  const infos = result.issues.filter((i) => i.level === "info");

  lines.push("### Issues");
  if (errors.length === 0 && warnings.length === 0) {
    lines.push("None — ready for publishing!");
  } else {
    if (errors.length > 0) {
      lines.push(`**Errors (${errors.length}):**`);
      for (const e of errors) {
        lines.push(`- ❌ ${e.message}`);
      }
    }
    if (warnings.length > 0) {
      lines.push(`**Warnings (${warnings.length}):**`);
      for (const w of warnings) {
        lines.push(`- ⚠️ ${w.message}`);
      }
    }
    if (infos.length > 0) {
      lines.push(`**Info (${infos.length}):**`);
      for (const i of infos) {
        lines.push(`- ℹ️ ${i.message}`);
      }
    }
  }
  lines.push("");

  // Summary
  lines.push("### Summary");
  if (!result.hasErrors) {
    lines.push("✅ All checks passed. Mod is ready for Workshop upload.");
  } else {
    const errCount = errors.length;
    const warnCount = warnings.length;
    lines.push(`❌ ${errCount} error(s) found. ${warnCount > 0 ? `${warnCount} warning(s). ` : ""}Fix errors before publishing.`);
  }

  return lines.join("\n");
}

// ─── Package builder ─────────────────────────────────────────────────────────

async function buildPackage(
  projectPath: string,
  outputPath: string
): Promise<string> {
  // Create output directory
  mkdirSync(outputPath, { recursive: true });

  // Collect all files to include
  const filesToInclude: string[] = [];

  walkAllFiles(projectPath, projectPath, (fullPath, relPath) => {
    // Skip build artifacts and workbench temp files
    const ext = extname(relPath).toLowerCase();
    const skipExts = new Set([".log", ".tmp", ".bak"]);
    const skipDirs = ["node_modules", ".git", "output", ".workbench"];

    const parts = relPath.split("/");
    if (parts.some((p) => skipDirs.includes(p.toLowerCase()))) return;
    if (skipExts.has(ext)) return;

    filesToInclude.push(relPath);
  });

  // Copy files to output
  for (const relPath of filesToInclude) {
    const srcPath = join(projectPath, relPath);
    const destPath = join(outputPath, relPath);
    mkdirSync(resolve(destPath, ".."), { recursive: true });

    try {
      const content = readFileSync(srcPath);
      writeFileSync(destPath, content);
    } catch {
      // Skip files we can't read
    }
  }

  return outputPath;
}

// ─── Register tool ───────────────────────────────────────────────────────────

export function registerProjectExport(server: McpServer, config: Config): void {
  server.registerTool(
    "project_export",
    {
      description:
        "Validate a mod for publishing and generate a distribution package. " +
        "Checks addon.gproj validity, script/prefab/config integrity, GUID uniqueness, " +
        "localization coverage, layout widget hierarchy, resource path resolution, " +
        "and placeholder/empty files. Reports issues by severity. " +
        "Can also generate a distributable package directory.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe("Mod project directory to validate or package. Uses configured default if omitted."),
        modName: z
          .string()
          .optional()
          .describe("(optional) Addon folder name. Used for context only."),
        action: z
          .enum(["validate", "package"])
          .default("validate")
          .describe("Action: 'validate' runs pre-publish checks, 'package' generates a distributable directory."),
      },
    },
    async ({ projectPath: inputProjectPath, modName, action }) => {
      const basePath = inputProjectPath || config.projectPath;

      if (!basePath) {
        return {
          content: [
            {
              type: "text",
              text: "No project path configured. Set ENFUSION_PROJECT_PATH environment variable or provide projectPath parameter.",
            },
          ],
          isError: true,
        };
      }

      if (!existsSync(basePath)) {
        return {
          content: [
            { type: "text", text: `Project directory not found: ${basePath}` },
          ],
          isError: true,
        };
      }

      // Validate path stays within configured project root
      try {
        if (inputProjectPath && config.projectPath) {
          validateProjectPath(config.projectPath, inputProjectPath);
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Invalid project path: ${msg}` }],
          isError: true,
        };
      }

      // Run validation
      const result = runValidation(basePath);
      const report = formatValidationReport(result);

      if (action === "validate") {
        return {
          content: [{ type: "text", text: report }],
          isError: result.hasErrors,
        };
      }

      // action === "package"
      if (result.hasErrors) {
        const errorReport = report + "\n\n---\n\n**Packaging aborted.** Fix all errors above before generating a distribution package.";
        return {
          content: [{ type: "text", text: errorReport }],
          isError: true,
        };
      }

      try {
        const projectName = modName || result.projectName;
        const packageDir = resolve(
          basePath,
          "..",
          `${projectName}_package`
        );

        await buildPackage(basePath, packageDir);

        // Count packaged files
        let fileCount = 0;
        let totalSize = 0;
        walkAllFiles(packageDir, packageDir, (fp) => {
          fileCount++;
          try {
            totalSize += statSync(fp).size;
          } catch { /* skip */ }
        });

        const packageReport = report +
          "\n\n---\n\n" +
          `### Package Generated\n` +
          `- Path: ${packageDir}\n` +
          `- Files: ${fileCount}\n` +
          `- Total size: ${formatSize(totalSize)}\n\n` +
          "Ready for Workshop upload or distribution.";

        return {
          content: [{ type: "text", text: packageReport }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text",
              text: report + `\n\n---\n\n**Packaging failed:** ${msg}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
