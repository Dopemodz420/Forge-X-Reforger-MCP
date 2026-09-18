import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, extname, relative, basename } from "node:path";
import type { Config } from "../config.js";
import { validateProjectPath } from "../utils/safe-path.js";
import { formatSize } from "../utils/dir-listing.js";

interface FileEntry {
  relPath: string;
  ext: string;
  size: number;
}

interface CodeMetrics {
  totalLines: number;
  classCount: number;
  moddedClassCount: number;
  methodCount: number;
  filesWithNoClass: string[];
}

interface UIQuality {
  layoutCount: number;
  namedWidgets: number;
  unnamedWidgets: number;
  layoutsReferencingScripts: number;
  unnamedWidgetDetails: Array<{ file: string; widgetType: string }>;
}

interface LocalizationCoverage {
  keysReferenced: Set<string>;
  keysDefined: Set<string>;
  missingKeys: string[];
}

interface PrefabAnalysis {
  prefabCount: number;
  emptyPrefabs: string[];
  componentTypes: Map<string, number>;
}

interface ConfigAnalysis {
  configCount: number;
  configs: Array<{ file: string; size: number }>;
}

interface Issues {
  emptyFiles: string[];
  largeFiles: Array<{ file: string; size: number }>;
  noClassFiles: string[];
  unnamedWidgets: Array<{ file: string; widgetType: string }>;
  missingLocKeys: string[];
  duplicateNames: Map<string, string[]>;
}

function walkDir(dir: string, basePath: string, results: FileEntry[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(basePath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      walkDir(fullPath, basePath, results);
    } else {
      const ext = extname(entry.name).toLowerCase();
      let size = 0;
      try {
        size = statSync(fullPath).size;
      } catch { /* skip */ }
      results.push({ relPath, ext, size });
    }
  }
}

function analyzeCodeMetrics(files: FileEntry[], basePath: string): CodeMetrics {
  const classRegex = /^(?:modded\s+)?class\s+(\w+)/gm;
  const methodRegex = /^\s*(?:override\s+|protected\s+|private\s+|public\s+|static\s+|abstract\s+|final\s+)*\w+(?:<[^>]+>)?\s+\w+\s*\([^)]*\)\s*(?:const\s*)?\{/gm;

  let totalLines = 0;
  let classCount = 0;
  let moddedClassCount = 0;
  let methodCount = 0;
  const filesWithNoClass: string[] = [];

  const cFiles = files.filter((f) => f.ext === ".c");

  for (const file of cFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const lines = content.split("\n");
    totalLines += lines.length;

    // Count classes
    let foundClass = false;
    let match;
    classRegex.lastIndex = 0;
    while ((match = classRegex.exec(content)) !== null) {
      foundClass = true;
      classCount++;
      const declLine = content.substring(
        content.lastIndexOf("\n", match.index) + 1,
        match.index
      );
      if (declLine.trimStart().startsWith("modded")) {
        moddedClassCount++;
      }
    }

    if (!foundClass && content.trim().length > 0) {
      filesWithNoClass.push(file.relPath);
    }

    // Count methods (lines with function signatures ending with {)
    methodRegex.lastIndex = 0;
    while ((match = methodRegex.exec(content)) !== null) {
      // Exclude lines inside comments
      const lineStart = content.lastIndexOf("\n", match.index) + 1;
      const line = content.substring(lineStart, match.index + match[0].length);
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("//") && !trimmed.startsWith("*")) {
        methodCount++;
      }
    }
  }

  const avgMethods = classCount > 0 ? methodCount / classCount : 0;

  return {
    totalLines,
    classCount,
    moddedClassCount,
    methodCount,
    filesWithNoClass,
  };
}

function analyzeUIQuality(files: FileEntry[], basePath: string): UIQuality {
  const layoutFiles = files.filter((f) => f.ext === ".layout");
  let namedWidgets = 0;
  let unnamedWidgets = 0;
  let layoutsReferencingScripts = 0;
  const unnamedWidgetDetails: Array<{ file: string; widgetType: string }> = [];

  // Widget class names to look for
  const widgetClasses = [
    "FrameWidget",
    "TextWidget",
    "ImageWidget",
    "ButtonWidget",
    "EditBoxWidget",
    "CheckBoxWidget",
    "SliderWidget",
    "ProgressBarWidget",
    "VerticalLayoutWidget",
    "HorizontalLayoutWidget",
    "GridLayoutWidget",
    "OverlayWidget",
    "ScrollLayoutWidget",
    "SizeLayoutWidget",
    "SpacerWidget",
    "RichTextWidget",
    "ComboBoxWidget",
    "XComboBoxWidget",
    "MultilineEditBoxWidget",
    "MapWidget",
    "CanvasWidget",
  ];

  for (const file of layoutFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    // Check for script references (handler components)
    if (content.includes("Script") || content.includes("Handler") || content.includes("SCR_")) {
      layoutsReferencingScripts++;
    }

    // Count named vs unnamed widgets
    for (const widgetClass of widgetClasses) {
      const widgetRegex = new RegExp(`${widgetClass}\\s*\\(`, "g");
      let match;
      while ((match = widgetRegex.exec(content)) !== null) {
        // Look for Name property nearby
        const afterWidget = content.substring(match.index, match.index + 500);
        if (/Name\s*=\s*"[^"]+"/.test(afterWidget)) {
          namedWidgets++;
        } else {
          unnamedWidgets++;
          unnamedWidgetDetails.push({ file: file.relPath, widgetType: widgetClass });
        }
      }
    }
  }

  return {
    layoutCount: layoutFiles.length,
    namedWidgets,
    unnamedWidgets,
    layoutsReferencingScripts,
    unnamedWidgetDetails,
  };
}

function analyzeLocalization(files: FileEntry[], basePath: string): LocalizationCoverage {
  const keysReferenced = new Set<string>();
  const keysDefined = new Set<string>();

  // Scan .c files for #STR_ references
  const cFiles = files.filter((f) => f.ext === ".c");
  for (const file of cFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const refRegex = /#(STR_[A-Z0-9_]+)/g;
    let match;
    while ((match = refRegex.exec(content)) !== null) {
      keysReferenced.add(match[1]);
    }
  }

  // Scan .layout files for #STR_ references
  const layoutFiles = files.filter((f) => f.ext === ".layout");
  for (const file of layoutFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    const refRegex = /#(STR_[A-Z0-9_]+)/g;
    let match;
    while ((match = refRegex.exec(content)) !== null) {
      keysReferenced.add(match[1]);
    }
  }

  // Scan .st files for defined keys
  const stFiles = files.filter((f) => f.ext === ".st");
  for (const file of stFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    // .st files are CSV: "KEY","Value"
    const keyRegex = /^"(STR_[A-Z0-9_]+)"/gm;
    let match;
    while ((match = keyRegex.exec(content)) !== null) {
      keysDefined.add(match[1]);
    }
  }

  const missingKeys = Array.from(keysReferenced).filter(
    (key) => !keysDefined.has(key)
  );

  return { keysReferenced, keysDefined, missingKeys };
}

function analyzePrefabs(files: FileEntry[], basePath: string): PrefabAnalysis {
  const prefabFiles = files.filter((f) => f.ext === ".et");
  const emptyPrefabs: string[] = [];
  const componentTypes = new Map<string, number>();

  for (const file of prefabFiles) {
    const fullPath = join(basePath, file.relPath);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    // Check for components
    const componentRegex = /class\s*=\s*"(\w+)"/g;
    let hasComponent = false;
    let match;
    while ((match = componentRegex.exec(content)) !== null) {
      hasComponent = true;
      const compName = match[1];
      componentTypes.set(compName, (componentTypes.get(compName) ?? 0) + 1);
    }

    if (!hasComponent && content.trim().length > 0) {
      emptyPrefabs.push(file.relPath);
    }
  }

  return {
    prefabCount: prefabFiles.length,
    emptyPrefabs,
    componentTypes,
  };
}

function analyzeConfigs(files: FileEntry[], basePath: string): ConfigAnalysis {
  const confFiles = files.filter((f) => f.ext === ".conf");
  const configs: Array<{ file: string; size: number }> = [];

  for (const file of confFiles) {
    configs.push({ file: file.relPath, size: file.size });
  }

  return { configCount: confFiles.length, configs };
}

function collectIssues(
  files: FileEntry[],
  codeMetrics: CodeMetrics,
  uiQuality: UIQuality,
  localization: LocalizationCoverage
): Issues {
  const emptyFiles = files
    .filter((f) => f.size === 0)
    .map((f) => f.relPath);

  const largeFiles = files
    .filter((f) => f.size > 500 * 1024)
    .map((f) => ({ file: f.relPath, size: f.size }))
    .sort((a, b) => b.size - a.size);

  // Duplicate file names across different directories
  const nameMap = new Map<string, string[]>();
  for (const file of files) {
    const name = basename(file.relPath);
    const existing = nameMap.get(name) ?? [];
    existing.push(file.relPath);
    nameMap.set(name, existing);
  }
  const duplicateNames = new Map<string, string[]>();
  for (const [name, paths] of nameMap) {
    if (paths.length > 1) {
      duplicateNames.set(name, paths);
    }
  }

  return {
    emptyFiles,
    largeFiles,
    noClassFiles: codeMetrics.filesWithNoClass,
    unnamedWidgets: uiQuality.unnamedWidgetDetails,
    missingLocKeys: localization.missingKeys,
    duplicateNames,
  };
}

function buildReport(
  projectPath: string,
  files: FileEntry[],
  codeMetrics: CodeMetrics,
  uiQuality: UIQuality,
  localization: LocalizationCoverage,
  prefabAnalysis: PrefabAnalysis,
  configAnalysis: ConfigAnalysis,
  issues: Issues
): string {
  const projectName = basename(projectPath);
  const lines: string[] = [];

  lines.push(`## Project Stats: ${projectName}`);
  lines.push("");

  // --- File Inventory ---
  lines.push("### File Inventory");

  const extMap = new Map<string, { count: number; size: number }>();
  let totalSize = 0;
  for (const file of files) {
    const ext = file.ext || "(none)";
    const entry = extMap.get(ext) ?? { count: 0, size: 0 };
    entry.count++;
    entry.size += file.size;
    extMap.set(ext, entry);
    totalSize += file.size;
  }

  const sortedExts = Array.from(extMap.entries()).sort((a, b) => b[1].count - a[1].count);
  for (const [ext, data] of sortedExts) {
    lines.push(`  ${ext.padEnd(14)} ${String(data.count).padStart(4)} files    ${formatSize(data.size).padStart(8)}`);
  }
  lines.push(`  ${"Total:".padEnd(14)} ${String(files.length).padStart(4)} files    ${formatSize(totalSize).padStart(8)}`);
  lines.push("");

  // --- Code Metrics ---
  if (codeMetrics.classCount > 0 || codeMetrics.totalLines > 0) {
    lines.push("### Code Metrics");
    lines.push(`  Lines of code: ${codeMetrics.totalLines.toLocaleString()}`);
    const moddedInfo = codeMetrics.moddedClassCount > 0
      ? ` (${codeMetrics.moddedClassCount} modded)`
      : "";
    lines.push(`  Classes: ${codeMetrics.classCount}${moddedInfo}`);
    lines.push(`  Methods: ${codeMetrics.methodCount}`);
    if (codeMetrics.classCount > 0) {
      lines.push(`  Avg methods/class: ${(codeMetrics.methodCount / codeMetrics.classCount).toFixed(1)}`);
    }
    lines.push("");
  }

  // --- UI Quality ---
  if (uiQuality.layoutCount > 0) {
    lines.push("### UI Quality");
    lines.push(`  Layouts: ${uiQuality.layoutCount}`);
    lines.push(`  Named widgets: ${uiQuality.namedWidgets}`);
    const unnamedIcon = uiQuality.unnamedWidgets > 0 ? " ⚠️" : "";
    lines.push(`  Unnamed widgets: ${uiQuality.unnamedWidgets}${unnamedIcon}`);
    lines.push(`  Layouts referencing scripts: ${uiQuality.layoutsReferencingScripts}`);
    lines.push("");
  }

  // --- Localization ---
  if (localization.keysReferenced.size > 0 || localization.keysDefined.size > 0) {
    lines.push("### Localization");
    lines.push(`  Keys referenced: ${localization.keysReferenced.size}`);
    lines.push(`  Keys defined: ${localization.keysDefined.size}`);
    if (localization.missingKeys.length > 0) {
      const keyList = localization.missingKeys.slice(0, 5).join(", ");
      const more = localization.missingKeys.length > 5
        ? ` (+${localization.missingKeys.length - 5} more)`
        : "";
      lines.push(`  Missing: ${localization.missingKeys.length} ⚠️  ${keyList}${more}`);
    } else if (localization.keysReferenced.size > 0) {
      lines.push(`  Missing: 0 ✓`);
    }
    lines.push("");
  }

  // --- Prefab Analysis ---
  if (prefabAnalysis.prefabCount > 0) {
    lines.push("### Prefabs");
    lines.push(`  Count: ${prefabAnalysis.prefabCount}`);
    if (prefabAnalysis.emptyPrefabs.length > 0) {
      lines.push(`  Empty/placeholder: ${prefabAnalysis.emptyPrefabs.length} ⚠️`);
    }
    if (prefabAnalysis.componentTypes.size > 0) {
      const sortedComps = Array.from(prefabAnalysis.componentTypes.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      lines.push(`  Top components:`);
      for (const [comp, count] of sortedComps) {
        lines.push(`    ${comp.padEnd(36)} ×${count}`);
      }
    }
    lines.push("");
  }

  // --- Config Analysis ---
  if (configAnalysis.configCount > 0) {
    lines.push("### Configs");
    lines.push(`  Count: ${configAnalysis.configCount}`);
    let totalConfSize = 0;
    for (const c of configAnalysis.configs) {
      totalConfSize += c.size;
    }
    lines.push(`  Total size: ${formatSize(totalConfSize)}`);
    lines.push("");
  }

  // --- Issues ---
  lines.push("### Issues");

  let issueCount = 0;

  if (issues.missingLocKeys.length > 0) {
    lines.push(`  ⚠️  ${issues.missingLocKeys.length} missing localization key(s)`);
    issueCount++;
  }

  if (issues.unnamedWidgets.length > 0) {
    lines.push(`  ⚠️  ${issues.unnamedWidgets.length} unnamed widget(s) in layouts`);
    issueCount++;
  }

  if (issues.noClassFiles.length > 0) {
    for (const f of issues.noClassFiles) {
      lines.push(`  ⚠️  .c file with no class declaration: ${f}`);
      issueCount++;
    }
  }

  if (issues.emptyFiles.length > 0) {
    for (const f of issues.emptyFiles) {
      lines.push(`  ℹ️  Empty file (0 bytes): ${f}`);
      issueCount++;
    }
  }

  if (issues.largeFiles.length > 0) {
    for (const f of issues.largeFiles) {
      lines.push(`  ⚠️  Large file (${formatSize(f.size)}): ${f.file}`);
      issueCount++;
    }
  }

  if (issues.duplicateNames.size > 0) {
    for (const [name, paths] of issues.duplicateNames) {
      lines.push(`  ℹ️  Duplicate filename "${name}": ${paths.join(", ")}`);
      issueCount++;
    }
  }

  if (issueCount === 0) {
    lines.push(`  ✓ No issues found`);
  }

  lines.push("");

  return lines.join("\n");
}

export function registerProjectStats(server: McpServer, config: Config): void {
  server.registerTool(
    "project_stats",
    {
      description:
        "Scan an entire mod project and produce a health dashboard — file counts by type, code metrics, UI quality, localization coverage, prefab analysis, and quality issues.",
      inputSchema: {
        projectPath: z
          .string()
          .optional()
          .describe("Mod project directory to scan. Uses configured default if omitted."),
      },
    },
    async ({ projectPath: inputProjectPath }) => {
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

      try {
        // Validate path stays within project root
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

      try {
        // Walk the project directory
        const files: FileEntry[] = [];
        walkDir(basePath, basePath, files);

        if (files.length === 0) {
          return {
            content: [
              {
                type: "text",
                text: `No files found in project directory: ${basePath}`,
              },
            ],
          };
        }

        // Run all analyses
        const codeMetrics = analyzeCodeMetrics(files, basePath);
        const uiQuality = analyzeUIQuality(files, basePath);
        const localization = analyzeLocalization(files, basePath);
        const prefabAnalysis = analyzePrefabs(files, basePath);
        const configAnalysis = analyzeConfigs(files, basePath);
        const issues = collectIssues(files, codeMetrics, uiQuality, localization);

        // Build report
        const report = buildReport(
          basePath,
          files,
          codeMetrics,
          uiQuality,
          localization,
          prefabAnalysis,
          configAnalysis,
          issues
        );

        return { content: [{ type: "text", text: report }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text", text: `Error scanning project: ${msg}` }],
          isError: true,
        };
      }
    }
  );
}
