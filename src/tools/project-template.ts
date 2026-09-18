import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  statSync,
} from "node:fs";
import { join, extname, relative, basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";
import { validateProjectPath, validateFilename } from "../utils/safe-path.js";
import { generateGproj } from "../templates/gproj.js";
import { generateScript } from "../templates/script.js";

// ─── types ──────────────────────────────────────────────────────────────────

interface ProjectTemplate {
  name: string;
  description: string;
  createdAt: string;
  sourcePath: string;
  files: Record<string, string[]>;
  classes: Array<{ name: string; parent?: string; type: string; file: string }>;
  configs: string[];
  layouts: string[];
  namingPrefix: string;
  addonDependencies: string[];
  gprojName?: string;
}

// ─── helpers ────────────────────────────────────────────────────────────────

function getTemplatesDir(): string {
  const home = homedir();
  return join(home, ".reforger-forge", "templates");
}

function getTemplatePath(name: string): string {
  return join(getTemplatesDir(), `${name}.json`);
}

function ensureTemplatesDir(): void {
  const dir = getTemplatesDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

function walkProject(dir: string, basePath: string, results: string[]): void {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith(".")) continue;
    if (entry.name === "node_modules") continue;

    const fullPath = join(dir, entry.name);
    const relPath = relative(basePath, fullPath).replace(/\\/g, "/");

    if (entry.isDirectory()) {
      walkProject(fullPath, basePath, results);
    } else {
      results.push(relPath);
    }
  }
}

function categorizeFiles(
  files: string[]
): Record<string, string[]> {
  const categories: Record<string, string[]> = {};

  for (const file of files) {
    const parts = file.split("/");
    // Use top-level directory as category key
    const category = parts.length > 1 ? parts[0] + "/" : "(root)/";
    if (!categories[category]) {
      categories[category] = [];
    }
    categories[category].push(file);
  }

  return categories;
}

function extractClasses(
  files: string[],
  basePath: string
): ProjectTemplate["classes"] {
  const classes: ProjectTemplate["classes"] = [];
  const classRegex = /^(?:modded\s+)?class\s+(\w+)(?:\s*:\s*(\w+))?/gm;

  for (const file of files) {
    if (!file.endsWith(".c")) continue;

    const fullPath = join(basePath, file);
    let content: string;
    try {
      content = readFileSync(fullPath, "utf-8");
    } catch {
      continue;
    }

    let match;
    classRegex.lastIndex = 0;
    while ((match = classRegex.exec(content)) !== null) {
      const className = match[1];
      const parentClass = match[2];
      const isModded = content
        .substring(content.lastIndexOf("\n", match.index) + 1, match.index)
        .trimStart()
        .startsWith("modded");

      classes.push({
        name: className,
        parent: parentClass,
        type: isModded ? "modded" : "class",
        file,
      });
    }
  }

  return classes;
}

function extractConfigs(files: string[]): string[] {
  return files.filter((f) => f.endsWith(".conf")).map((f) => basename(f, ".conf"));
}

function extractLayouts(files: string[]): string[] {
  return files
    .filter((f) => f.endsWith(".layout"))
    .map((f) => basename(f, ".layout"));
}

function detectNamingPrefix(classes: ProjectTemplate["classes"]): string {
  const prefixCounts = new Map<string, number>();

  for (const cls of classes) {
    const match = cls.name.match(/^([A-Z]+)_/);
    if (match) {
      const prefix = match[1];
      prefixCounts.set(prefix, (prefixCounts.get(prefix) || 0) + 1);
    }
  }

  if (prefixCounts.size === 0) return "";

  let bestPrefix = "";
  let bestCount = 0;
  for (const [prefix, count] of prefixCounts) {
    if (count > bestCount) {
      bestPrefix = prefix;
      bestCount = count;
    }
  }

  return bestPrefix;
}

function extractGprojDeps(projectPath: string, files: string[]): string[] {
  const gprojFile = files.find((f) => f.endsWith(".gproj"));
  if (!gprojFile) return ["ArmaReforger", "Core"];

  const fullPath = join(projectPath, gprojFile);
  let content: string;
  try {
    content = readFileSync(fullPath, "utf-8");
  } catch {
    return ["ArmaReforger", "Core"];
  }

  const deps: string[] = [];
  // Simple parse: look for GUID values in Dependencies block
  const guidRegex = /([0-9A-Fa-f]{16})/g;
  let match;
  while ((match = guidRegex.exec(content)) !== null) {
    const guid = match[1];
    // Skip the base game GUID (58D0FB3206B6F859)
    if (guid !== "58D0FB3206B6F859") {
      deps.push(guid);
    }
  }

  return deps.length > 0 ? deps : ["ArmaReforger", "Core"];
}

// ─── scaffold helpers ───────────────────────────────────────────────────────

interface ScaffoldOptions {
  template: ProjectTemplate;
  targetDir: string;
  modName: string;
  prefix?: string;
}

function scaffoldProject(opts: ScaffoldOptions): string[] {
  const { template, targetDir, modName, prefix } = opts;
  const classPrefix = prefix || template.namingPrefix || "MOD";
  const createdFiles: string[] = [];

  // Create base directories
  const dirs = [
    targetDir,
    join(targetDir, "Scripts", "Game"),
    join(targetDir, "Prefabs"),
    join(targetDir, "PrefabsEditable"),
    join(targetDir, "Configs"),
    join(targetDir, "Language"),
    join(targetDir, "Missions"),
    join(targetDir, "UI"),
    join(targetDir, "Worlds"),
  ];

  // Add any extra directories from the template
  for (const category of Object.keys(template.files)) {
    const topDir = category.split("/")[0];
    if (topDir && topDir !== "(root)") {
      const dirPath = join(targetDir, topDir);
      if (!dirs.includes(dirPath)) {
        dirs.push(dirPath);
      }
    }
  }

  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }

  // Generate .gproj
  const gprojContent = generateGproj({
    name: modName,
    title: modName,
    dependencies: template.addonDependencies,
  });
  writeFileSync(join(targetDir, `${modName}.gproj`), gprojContent, "utf-8");
  createdFiles.push(`${modName}.gproj`);

  // Generate script files from template classes
  for (const cls of template.classes) {
    const className = cls.name.replace(
      new RegExp(`^${template.namingPrefix}_`),
      `${classPrefix}_`
    );

    let scriptType: "component" | "gamemode" | "modded" | "basic" | "action" | "entity" | "manager" = "basic";
    if (cls.type === "modded") {
      scriptType = "modded";
    } else if (cls.parent) {
      if (cls.parent.includes("GameMode")) scriptType = "gamemode";
      else if (cls.parent.includes("Component")) scriptType = "component";
      else if (cls.parent.includes("Action")) scriptType = "action";
      else if (cls.parent.includes("Entity")) scriptType = "entity";
    }

    const parentClass =
      cls.parent && scriptType !== "modded" ? cls.parent : undefined;

    const code = generateScript({
      className,
      scriptType,
      parentClass: scriptType === "modded" ? cls.parent : parentClass,
      description: `Scaffolded from template: ${template.name}`,
    });

    const scriptPath = join(targetDir, "Scripts", "Game", `${className}.c`);
    writeFileSync(scriptPath, code, "utf-8");
    createdFiles.push(`Scripts/Game/${className}.c`);
  }

  // Create placeholder config files
  for (const configName of template.configs) {
    const configPath = join(targetDir, "Configs", `${configName}.conf`);
    if (!existsSync(configPath)) {
      writeFileSync(configPath, `// Scaffolded from template: ${template.name}\n`, "utf-8");
      createdFiles.push(`Configs/${configName}.conf`);
    }
  }

  // Create placeholder layout files
  for (const layoutName of template.layouts) {
    const layoutDir = join(targetDir, "UI", "layouts");
    mkdirSync(layoutDir, { recursive: true });
    const layoutPath = join(layoutDir, `${layoutName}.layout`);
    if (!existsSync(layoutPath)) {
      writeFileSync(
        layoutPath,
        `// Scaffolded from template: ${template.name}\n// Open in Workbench Layout Editor to build UI\n`,
        "utf-8"
      );
      createdFiles.push(`UI/layouts/${layoutName}.layout`);
    }
  }

  return createdFiles;
}

// ─── format helpers ─────────────────────────────────────────────────────────

function formatFileSummary(files: Record<string, string[]>): string {
  const counts: Record<string, number> = {};
  for (const [category, fileList] of Object.entries(files)) {
    const topDir = category.split("/")[0];
    counts[topDir] = (counts[topDir] || 0) + fileList.length;
  }

  const parts: string[] = [];
  for (const [dir, count] of Object.entries(counts)) {
    parts.push(`${count} ${dir}`);
  }
  return parts.join(", ");
}

// ─── register ───────────────────────────────────────────────────────────────

export function registerProjectTemplate(
  server: McpServer,
  config: Config
): void {
  server.registerTool(
    "project_template",
    {
      description:
        "Save and restore mod project structures as reusable templates. Scan a project to save its structure, list saved templates, scaffold new projects from templates, or view template details.",
      inputSchema: {
        action: z
          .enum(["save", "list", "scaffold", "info"])
          .describe(
            "Action to perform: 'save' captures a project as a template, 'list' shows all saved templates, 'scaffold' creates a new project from a template, 'info' shows detailed template information."
          ),
        projectPath: z
          .string()
          .optional()
          .describe(
            "Mod project directory to scan (for save) or parent directory for scaffold output. Uses configured default if omitted."
          ),
        templateName: z
          .string()
          .optional()
          .describe(
            "Template name. Required for 'save' (auto-derived from project dir if omitted), 'scaffold', and 'info' actions."
          ),
        outputPath: z
          .string()
          .optional()
          .describe(
            "(scaffold) Where to create the new project directory. Defaults to the configured project path."
          ),
        description: z
          .string()
          .optional()
          .describe(
            "(save) Custom description for the template. Auto-generated if omitted."
          ),
        prefix: z
          .string()
          .min(1)
          .max(4)
          .optional()
          .describe(
            "(scaffold) Class name prefix override (e.g., 'MCM'). Uses template's detected prefix if omitted."
          ),
      },
    },
    async ({
      action,
      projectPath: inputProjectPath,
      templateName,
      outputPath,
      description: customDescription,
      prefix,
    }) => {
      // ── save ─────────────────────────────────────────────────────────────
      if (action === "save") {
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

        try {
          // Walk all files
          const files: string[] = [];
          walkProject(basePath, basePath, files);

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

          // Analyze project
          const categorized = categorizeFiles(files);
          const classes = extractClasses(files, basePath);
          const configs = extractConfigs(files);
          const layouts = extractLayouts(files);
          const namingPrefix = detectNamingPrefix(classes);
          const deps = extractGprojDeps(basePath, files);

          // Determine template name
          const name =
            templateName || basename(basePath).replace(/[^a-zA-Z0-9_-]/g, "_");

          try {
            validateFilename(name);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [
                { type: "text", text: `Invalid template name: ${msg}` },
              ],
              isError: true,
            };
          }

          // Build template
          const template: ProjectTemplate = {
            name,
            description:
              customDescription ||
              `Project template derived from ${basename(basePath)}`,
            createdAt: new Date().toISOString(),
            sourcePath: basePath,
            files: categorized,
            classes,
            configs,
            layouts,
            namingPrefix,
            addonDependencies: deps,
            gprojName: files.find((f) => f.endsWith(".gproj"))
              ? basename(files.find((f) => f.endsWith(".gproj"))!, ".gproj")
              : undefined,
          };

          // Save
          ensureTemplatesDir();
          const templatePath = getTemplatePath(name);
          writeFileSync(templatePath, JSON.stringify(template, null, 2), "utf-8");

          // Build report
          const lines: string[] = [];
          lines.push(`## Template Saved: ${name}`);
          lines.push("");
          lines.push(`**Source:** ${basePath}`);
          lines.push(`**Description:** ${template.description}`);
          lines.push(`**Saved to:** ${templatePath}`);
          lines.push("");
          lines.push("### Project Structure");
          for (const [category, fileList] of Object.entries(categorized)) {
            lines.push(`  ${category} (${fileList.length} files)`);
          }
          lines.push("");
          if (classes.length > 0) {
            lines.push(`### Classes (${classes.length})`);
            for (const cls of classes) {
              const tag = cls.type === "modded" ? " [modded]" : "";
              const parent = cls.parent ? ` : ${cls.parent}` : "";
              lines.push(`  ${cls.name}${parent}${tag} — ${cls.file}`);
            }
            lines.push("");
          }
          if (configs.length > 0) {
            lines.push(`### Configs (${configs.length})`);
            for (const c of configs) lines.push(`  ${c}`);
            lines.push("");
          }
          if (layouts.length > 0) {
            lines.push(`### Layouts (${layouts.length})`);
            for (const l of layouts) lines.push(`  ${l}`);
            lines.push("");
          }
          if (namingPrefix) {
            lines.push(`**Detected prefix:** ${namingPrefix}_`);
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [
              { type: "text", text: `Error saving template: ${msg}` },
            ],
            isError: true,
          };
        }
      }

      // ── list ─────────────────────────────────────────────────────────────
      if (action === "list") {
        ensureTemplatesDir();
        const templatesDir = getTemplatesDir();

        try {
          const entries = readdirSync(templatesDir).filter((f) =>
            f.endsWith(".json")
          );

          if (entries.length === 0) {
            return {
              content: [
                {
                  type: "text",
                  text: "No saved templates found.\n\nUse action='save' with a project path to create your first template.",
                },
              ],
            };
          }

          const lines: string[] = [];
          lines.push("## Saved Templates");
          lines.push("");

          let index = 1;
          for (const entry of entries) {
            const fullPath = join(templatesDir, entry);
            try {
              const raw = readFileSync(fullPath, "utf-8");
              const tmpl = JSON.parse(raw) as ProjectTemplate;

              const fileCount = Object.values(tmpl.files).reduce(
                (sum, arr) => sum + arr.length,
                0
              );
              const scriptCount = tmpl.classes.length;
              const configCount = tmpl.configs.length;
              const layoutCount = tmpl.layouts.length;

              const fileParts: string[] = [];
              if (scriptCount > 0) fileParts.push(`${scriptCount} scripts`);
              if (configCount > 0) fileParts.push(`${configCount} configs`);
              if (layoutCount > 0) fileParts.push(`${layoutCount} layouts`);
              const otherCount = fileCount - scriptCount - configCount - layoutCount;
              if (otherCount > 0) fileParts.push(`${otherCount} other`);

              lines.push(`${index}. ${tmpl.name}`);
              lines.push(`   Description: ${tmpl.description}`);
              lines.push(
                `   Files: ${fileParts.join(", ") || fileCount + " total"}`
              );
              if (tmpl.namingPrefix) {
                lines.push(`   Prefix: ${tmpl.namingPrefix}_`);
              }
              lines.push("");
              index++;
            } catch {
              // Skip malformed template files
              lines.push(`${index}. ${entry.replace(".json", "")} (corrupt)`);
              lines.push("");
              index++;
            }
          }

          lines.push(
            `${entries.length} template(s) total. Use action='info' with templateName for details.`
          );

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [
              { type: "text", text: `Error listing templates: ${msg}` },
            ],
            isError: true,
          };
        }
      }

      // ── info ─────────────────────────────────────────────────────────────
      if (action === "info") {
        if (!templateName) {
          return {
            content: [
              {
                type: "text",
                text: "action='info' requires a 'templateName' parameter.",
              },
            ],
            isError: true,
          };
        }

        ensureTemplatesDir();
        const templatePath = getTemplatePath(templateName);

        if (!existsSync(templatePath)) {
          return {
            content: [
              {
                type: "text",
                text: `Template not found: ${templateName}\n\nUse action='list' to see available templates.`,
              },
            ],
            isError: true,
          };
        }

        try {
          const raw = readFileSync(templatePath, "utf-8");
          const tmpl = JSON.parse(raw) as ProjectTemplate;

          const lines: string[] = [];
          lines.push(`## Template: ${tmpl.name}`);
          lines.push("");
          lines.push(`**Description:** ${tmpl.description}`);
          lines.push(`**Source:** ${tmpl.sourcePath}`);
          lines.push(`**Created:** ${tmpl.createdAt}`);
          if (tmpl.namingPrefix) {
            lines.push(`**Naming prefix:** ${tmpl.namingPrefix}_`);
          }
          if (tmpl.addonDependencies.length > 0) {
            lines.push(`**Dependencies:** ${tmpl.addonDependencies.join(", ")}`);
          }
          lines.push("");

          // Files breakdown
          lines.push("### Files");
          for (const [category, fileList] of Object.entries(tmpl.files)) {
            lines.push(`**${category}**`);
            for (const f of fileList) {
              lines.push(`  ${f}`);
            }
            lines.push("");
          }

          // Classes
          if (tmpl.classes.length > 0) {
            lines.push("### Classes");
            for (const cls of tmpl.classes) {
              const tag = cls.type === "modded" ? " [modded]" : "";
              const parent = cls.parent ? ` : ${cls.parent}` : "";
              lines.push(`  ${cls.name}${parent}${tag}`);
              lines.push(`    File: ${cls.file}`);
            }
            lines.push("");
          }

          // Configs
          if (tmpl.configs.length > 0) {
            lines.push("### Configs");
            for (const c of tmpl.configs) {
              lines.push(`  ${c}.conf`);
            }
            lines.push("");
          }

          // Layouts
          if (tmpl.layouts.length > 0) {
            lines.push("### Layouts");
            for (const l of tmpl.layouts) {
              lines.push(`  ${l}.layout`);
            }
            lines.push("");
          }

          // Scaffold usage
          lines.push("### Scaffold Command");
          lines.push(
            `  Use action='scaffold' with templateName='${tmpl.name}' and a target projectPath.`
          );
          if (tmpl.namingPrefix) {
            lines.push(
              `  Detected prefix: ${tmpl.namingPrefix}_ (override with prefix param)`
            );
          }

          return { content: [{ type: "text", text: lines.join("\n") }] };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            content: [
              { type: "text", text: `Error reading template: ${msg}` },
            ],
            isError: true,
          };
        }
      }

      // ── scaffold ─────────────────────────────────────────────────────────
      // action === "scaffold"
      if (!templateName) {
        return {
          content: [
            {
              type: "text",
              text: "action='scaffold' requires a 'templateName' parameter.",
            },
          ],
          isError: true,
        };
      }

      ensureTemplatesDir();
      const templatePath = getTemplatePath(templateName);

      if (!existsSync(templatePath)) {
        return {
          content: [
            {
              type: "text",
              text: `Template not found: ${templateName}\n\nUse action='list' to see available templates.`,
            },
          ],
          isError: true,
        };
      }

      const targetBase = outputPath || config.projectPath;

      if (!targetBase) {
        return {
          content: [
            {
              type: "text",
              text: "No output path configured. Set ENFUSION_PROJECT_PATH environment variable or provide outputPath parameter.",
            },
          ],
          isError: true,
        };
      }

      try {
        const raw = readFileSync(templatePath, "utf-8");
        const tmpl = JSON.parse(raw) as ProjectTemplate;

        // Use template name as the new project directory name
        const newProjectName = templateName;
        const targetDir = join(targetBase, newProjectName);

        if (existsSync(targetDir)) {
          return {
            content: [
              {
                type: "text",
                text: `Directory already exists: ${targetDir}\nUse a different templateName or remove the existing directory.`,
              },
            ],
          };
        }

        const createdFiles = scaffoldProject({
          template: tmpl,
          targetDir,
          modName: newProjectName,
          prefix,
        });

        // Build response
        const lines: string[] = [];
        lines.push(`## Project Scaffolded: ${newProjectName}`);
        lines.push("");
        lines.push(`**Template:** ${tmpl.name}`);
        lines.push(`**Path:** ${targetDir}`);
        if (prefix || tmpl.namingPrefix) {
          lines.push(
            `**Class prefix:** ${prefix || tmpl.namingPrefix}_`
          );
        }
        lines.push("");
        lines.push("### Created Files");
        for (const f of createdFiles) {
          lines.push(`- ${f}`);
        }
        lines.push("");
        lines.push("### Directory Structure");
        lines.push(`${newProjectName}/`);
        lines.push(`  ${newProjectName}.gproj`);
        lines.push("  Scripts/");
        lines.push("    Game/");
        for (const f of createdFiles) {
          if (f.startsWith("Scripts/Game/")) {
            lines.push(`      ${f.replace("Scripts/Game/", "")}`);
          }
        }
        lines.push("  Prefabs/");
        lines.push("  PrefabsEditable/");
        lines.push("  Configs/");
        for (const f of createdFiles) {
          if (f.startsWith("Configs/")) {
            lines.push(`    ${f.replace("Configs/", "")}`);
          }
        }
        lines.push("  Language/");
        lines.push("  Missions/");
        lines.push("  UI/");
        if (createdFiles.some((f) => f.startsWith("UI/"))) {
          for (const f of createdFiles) {
            if (f.startsWith("UI/")) {
              lines.push(`    ${f.replace("UI/", "")}`);
            }
          }
        }
        lines.push("  Worlds/");
        lines.push("");
        lines.push(
          "Project scaffolded from template. Open in Enfusion Workbench to continue building."
        );

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text", text: `Error scaffolding project: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
