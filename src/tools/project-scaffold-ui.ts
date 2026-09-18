import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mkdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import type { Config } from "../config.js";
import {
  generateLayout,
  getLayoutSubdirectory,
  getLayoutFilename,
  type LayoutType,
  type WidgetDef,
} from "../templates/layout.js";
import { validateFilename } from "../utils/safe-path.js";

// ─── Widget kind → Enfusion class/type mapping ──────────────────────────────

const WIDGET_CLASS_MAP: Record<string, string> = {
  text: "TextWidgetClass",
  image: "ImageWidgetClass",
  button: "ButtonWidgetClass",
  progress: "ProgressBarWidgetClass",
  container: "FrameWidgetClass",
};

const WIDGET_CAST_MAP: Record<string, string> = {
  text: "TextWidget",
  image: "ImageWidget",
  button: "ButtonWidget",
  progress: "ProgressBarWidget",
  container: "FrameWidget",
};

const WIDGET_DEFAULTS: Record<
  string,
  { properties?: Record<string, string>; offset?: string }
> = {
  text: {
    properties: { Text: "", ExactFontSize: "14" },
    offset: "0 0 0 20",
  },
  image: {
    properties: { Color: "255 255 255 255" },
    offset: "0 0 40 40",
  },
  button: {
    properties: { Text: "" },
    offset: "0 0 120 36",
  },
  progress: {
    properties: { Current: "0" },
    offset: "0 0 200 20",
  },
  container: {
    properties: {},
    offset: "0 0 200 100",
  },
};

// ─── Layout generation ───────────────────────────────────────────────────────

function mapWidgetsToLayout(
  widgets: Array<{ name: string; kind: string }>,
  layoutType: LayoutType
): WidgetDef[] {
  const result: WidgetDef[] = [];
  let yOffset = 40;

  for (const w of widgets) {
    const defaults = WIDGET_DEFAULTS[w.kind] ?? WIDGET_DEFAULTS.container;
    const widgetClass = WIDGET_CLASS_MAP[w.kind] ?? "FrameWidgetClass";

    let anchor: string;
    if (layoutType === "hud") {
      anchor = `0 0 1 0`;
    } else {
      anchor = `0 0 1 0`;
    }

    const offset = defaults.offset ?? `0 0 200 20`;
    const [l, t, r, b] = offset.split(" ").map(Number);
    const spacedOffset = `${l} ${yOffset} ${r} ${yOffset + Math.abs(b - t)}`;

    yOffset += Math.abs(b - t) + 8;

    result.push({
      type: widgetClass,
      name: w.name,
      anchor,
      offset: spacedOffset,
      properties: { ...defaults.properties },
    });
  }

  return result;
}

// ─── Script generation ───────────────────────────────────────────────────────

interface ScriptGenOptions {
  className: string;
  parentClass: string;
  type: LayoutType;
  layoutName: string;
  widgets: Array<{ name: string; kind: string }>;
  prefix: string;
}

function generateUIScript(opts: ScriptGenOptions): string {
  const lines: string[] = [];
  const { className, parentClass, type, layoutName, widgets, prefix } = opts;

  lines.push(`// Auto-generated UI handler for ${layoutName}`);
  lines.push(`// Widget references kept in sync with ${layoutName}.layout`);
  lines.push("");

  lines.push(`class ${className} : ${parentClass}`);
  lines.push("{");

  // Member variables
  lines.push(`    protected Widget m_wRoot;`);
  for (const w of widgets) {
    const castType = WIDGET_CAST_MAP[w.kind] ?? "Widget";
    lines.push(`    protected ${castType} m_w${w.name};`);
  }
  lines.push("");

  if (type === "menu" || type === "dialog") {
    // Menu / Dialog lifecycle
    lines.push(`    override void OnMenuOpen()`);
    lines.push(`    {`);
    lines.push(`        super.OnMenuOpen();`);
    lines.push("");
    lines.push(`        m_wRoot = GetGame().GetWorkspace().CreateWidgets("{MOD}/UI/layouts/${layoutName}.layout");`);
    lines.push(`        if (!m_wRoot)`);
    lines.push(`        {`);
    lines.push(`            Print("[${className}] Failed to create layout: ${layoutName}", LogLevel.ERROR);`);
    lines.push(`            return;`);
    lines.push(`        }`);
    lines.push("");

    for (const w of widgets) {
      const castType = WIDGET_CAST_MAP[w.kind] ?? "Widget";
      lines.push(`        m_w${w.name} = ${castType}.Cast(m_wRoot.FindAnyWidget("${w.name}"));`);
    }
    lines.push("");

    lines.push(`        // TODO: Wire event handlers and initialize widget state`);
    lines.push(`    }`);
    lines.push("");
    lines.push(`    override void OnMenuClose()`);
    lines.push(`    {`);
    lines.push(`        if (m_wRoot)`);
    lines.push(`        {`);
    lines.push(`            m_wRoot.RemoveFromHierarchy();`);
    lines.push(`            m_wRoot = null;`);
    lines.push(`        }`);
    lines.push(`        super.OnMenuClose();`);
    lines.push(`    }`);
  } else {
    // HUD lifecycle
    lines.push(`    override event void OnInit(IEntity owner)`);
    lines.push(`    {`);
    lines.push(`        super.OnInit(owner);`);
    lines.push("");
    lines.push(`        m_wRoot = GetGame().GetWorkspace().CreateWidgets("{MOD}/UI/layouts/${layoutName}.layout");`);
    lines.push(`        if (!m_wRoot)`);
    lines.push(`        {`);
    lines.push(`            Print("[${className}] Failed to create layout: ${layoutName}", LogLevel.ERROR);`);
    lines.push(`            return;`);
    lines.push(`        }`);
    lines.push("");

    for (const w of widgets) {
      const castType = WIDGET_CAST_MAP[w.kind] ?? "Widget";
      lines.push(`        m_w${w.name} = ${castType}.Cast(m_wRoot.FindAnyWidget("${w.name}"));`);
    }
    lines.push("");

    lines.push(`        // TODO: Wire event handlers and initialize widget state`);
    lines.push(`    }`);
    lines.push("");
    lines.push(`    override event void OnUpdate(float timeSlice)`);
    lines.push(`    {`);
    lines.push(`        // TODO: Per-frame HUD updates (guard with dirty flags to avoid spam)`);
    lines.push(`    }`);
    lines.push("");
    lines.push(`    override event void Show(bool show)`);
    lines.push(`    {`);
    lines.push(`        if (m_wRoot) m_wRoot.SetVisible(show);`);
    lines.push(`    }`);
  }

  lines.push("}");
  lines.push("");
  return lines.join("\n");
}

// ─── Imageset generation ─────────────────────────────────────────────────────

function generateImageset(
  name: string,
  widgets: Array<{ name: string; kind: string }>
): string {
  const lines: string[] = [];
  lines.push(`<?xml version="1.0" encoding="UTF-8"?>`);
  lines.push(`<imageset name="${name}">`);

  const imageWidgets = widgets.filter((w) => w.kind === "image");
  if (imageWidgets.length === 0) {
    lines.push(`    <!-- Add image entries here. Each entry maps a name to a .edds texture. -->`);
    lines.push(`    <!-- Example: <image name="icon_example" path="{GUID}/UI/textures/icons/icon_example.edds" /> -->`);
  } else {
    for (const w of imageWidgets) {
      lines.push(`    <image name="${w.name}" path="{GUID}/UI/textures/icons/${w.name}.edds" />`);
    }
  }

  lines.push(`</imageset>`);
  lines.push("");
  return lines.join("\n");
}

// ─── Localization generation ─────────────────────────────────────────────────

interface LocEntry {
  key: string;
  value: string;
}

function generateLocalizationKeys(
  prefix: string,
  name: string,
  widgets: Array<{ name: string; kind: string }>
): LocEntry[] {
  const entries: LocEntry[] = [];
  const prefixClean = prefix.replace(/[^a-zA-Z0-9]/g, "");
  const nameClean = name.replace(/[^a-zA-Z0-9]/g, "").toUpperCase();

  entries.push({
    key: `STR_${prefixClean}${nameClean}_TITLE`,
    value: humanize(name),
  });

  for (const w of widgets) {
    if (w.kind === "text" || w.kind === "button") {
      entries.push({
        key: `STR_${prefixClean}${nameClean}_${w.name.toUpperCase()}`,
        value: humanize(w.name),
      });
    }
  }

  return entries;
}

function generateStringTable(
  modName: string,
  entries: LocEntry[]
): string {
  const lines: string[] = [];
  lines.push('<?xml version="1.0" encoding="utf-8"?>');
  lines.push("<StringTable>");
  lines.push(`\t<Package Name="${escapeXml(modName)}">`);

  for (const entry of entries) {
    lines.push(`\t\t<Key Id="${escapeXml(entry.key)}">`);
    lines.push(`\t\t\t<Original>${escapeXml(entry.value)}</Original>`);
    lines.push("\t\t</Key>");
  }

  lines.push("\t</Package>");
  lines.push("</StringTable>");
  lines.push("");
  return lines.join("\n");
}

function humanize(s: string): string {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ─── File size helper ────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function fileSize(path: string): string {
  try {
    return formatSize(statSync(path).size);
  } catch {
    return "? B";
  }
}

// ─── Register tool ───────────────────────────────────────────────────────────

export function registerProjectScaffoldUI(
  server: McpServer,
  config: Config
): void {
  server.registerTool(
    "project_scaffold_ui",
    {
      description:
        "Generate a complete UI subsystem — layout + script + imageset + localization — as a coordinated set with matching widget names. " +
        "Creates a .layout with named widgets, a handler .c script with FindAnyWidget bindings, an .imageset for any image widgets, " +
        "and #STR_ localization keys. All files share a consistent widget registry so layout names match script references.",
      inputSchema: {
        name: z
          .string()
          .min(1)
          .describe("UI component name (e.g., 'HealthBar', 'TraderMenu')"),
        projectPath: z
          .string()
          .optional()
          .describe("Mod project directory. Uses configured default if omitted."),
        type: z
          .enum(["hud", "menu", "dialog"])
          .default("hud")
          .describe("UI type. 'hud' = persistent on-screen element (SCR_InfoDisplay). 'menu' = full-screen modal (ChimeraMenuBase). 'dialog' = centered popup (ChimeraMenuBase)."),
        widgets: z
          .array(
            z.object({
              name: z.string().min(1).describe("Widget name (used for FindAnyWidget lookups)"),
              kind: z
                .enum(["text", "image", "button", "progress", "container"])
                .describe("Widget kind: text, image, button, progress, container"),
            })
          )
          .optional()
          .describe("Widget specifications. Each widget gets a unique Name in the layout and a member variable in the script."),
        prefix: z
          .string()
          .default("SCR_")
          .describe("Class name prefix for the generated script class"),
      },
    },
    async ({ name, projectPath, type, widgets, prefix }) => {
      const basePath = projectPath || config.projectPath;
      const layoutType = (type ?? "hud") as LayoutType;
      const widgetDefs = widgets ?? [];
      const prefixStr = prefix ?? "SCR_";

      try {
        validateFilename(name);

        const className = `${prefixStr}${name}`;

        // ── Resolve parent class ──────────────────────────────────────────
        let parentClass: string;
        switch (layoutType) {
          case "menu":
          case "dialog":
            parentClass = "ChimeraMenuBase";
            break;
          case "hud":
          default:
            parentClass = "SCR_InfoDisplay";
            break;
        }

        // ── Generate layout ──────────────────────────────────────────────
        const layoutWidgets = mapWidgetsToLayout(widgetDefs, layoutType);
        const layoutContent = generateLayout({
          name,
          layoutType,
          widgets: layoutWidgets,
          description: `Auto-generated ${layoutType} layout for ${name}`,
        });

        // ── Generate script ──────────────────────────────────────────────
        const scriptContent = generateUIScript({
          className,
          parentClass,
          type: layoutType,
          layoutName: name,
          widgets: widgetDefs,
          prefix: prefixStr,
        });

        // ── Generate imageset ────────────────────────────────────────────
        const imagesetContent = generateImageset(name, widgetDefs);

        // ── Generate localization ─────────────────────────────────────────
        const locEntries = generateLocalizationKeys(prefixStr, name, widgetDefs);
        const locContent = generateStringTable(name, locEntries);

        // ── Write files ──────────────────────────────────────────────────
        const createdFiles: Array<{ relPath: string; absPath: string }> = [];
        const skippedFiles: string[] = [];

        if (basePath) {
          // Layout
          const layoutDir = resolve(basePath, getLayoutSubdirectory());
          const layoutFile = getLayoutFilename(name);
          const layoutPath = join(layoutDir, layoutFile);
          mkdirSync(layoutDir, { recursive: true });
          if (!existsSync(layoutPath)) {
            writeFileSync(layoutPath, layoutContent, "utf-8");
            createdFiles.push({
              relPath: `${getLayoutSubdirectory()}/${layoutFile}`,
              absPath: layoutPath,
            });
          } else {
            skippedFiles.push(`${getLayoutSubdirectory()}/${layoutFile}`);
          }

          // Script
          const scriptDir = resolve(
            basePath,
            "Scripts/Game/UI",
            name
          );
          const scriptFile = `${className}.c`;
          const scriptPath = join(scriptDir, scriptFile);
          mkdirSync(scriptDir, { recursive: true });
          if (!existsSync(scriptPath)) {
            writeFileSync(scriptPath, scriptContent, "utf-8");
            createdFiles.push({
              relPath: `Scripts/Game/UI/${name}/${scriptFile}`,
              absPath: scriptPath,
            });
          } else {
            skippedFiles.push(`Scripts/Game/UI/${name}/${scriptFile}`);
          }

          // Imageset
          const imagesetDir = resolve(basePath, "UI/imagesets");
          const imagesetFile = `${name}.imageset`;
          const imagesetPath = join(imagesetDir, imagesetFile);
          mkdirSync(imagesetDir, { recursive: true });
          if (!existsSync(imagesetPath)) {
            writeFileSync(imagesetPath, imagesetContent, "utf-8");
            createdFiles.push({
              relPath: `UI/imagesets/${imagesetFile}`,
              absPath: imagesetPath,
            });
          } else {
            skippedFiles.push(`UI/imagesets/${imagesetFile}`);
          }

          // Localization
          const locDir = resolve(basePath, "Language");
          const locFile = `${name}_enUS.st`;
          const locPath = join(locDir, locFile);
          mkdirSync(locDir, { recursive: true });
          if (!existsSync(locPath)) {
            writeFileSync(locPath, locContent, "utf-8");
            createdFiles.push({
              relPath: `Language/${locFile}`,
              absPath: locPath,
            });
          } else {
            skippedFiles.push(`Language/${locFile}`);
          }
        }

        // ── Build report ─────────────────────────────────────────────────
        const lines: string[] = [];

        lines.push(`## UI Scaffold: ${name} (${layoutType} type)`);
        lines.push("");

        // Files
        lines.push("### Files Created");
        if (createdFiles.length > 0) {
          for (const f of createdFiles) {
            lines.push(`  ${f.relPath} (${fileSize(f.absPath)})`);
          }
        } else {
          lines.push("  _(no project path configured — files not written to disk)_");
        }
        if (skippedFiles.length > 0) {
          lines.push("");
          lines.push("### Skipped (already exist)");
          for (const f of skippedFiles) {
            lines.push(`  ${f}`);
          }
        }
        lines.push("");

        // Widget registry
        lines.push("### Widget Registry");
        if (widgetDefs.length === 0) {
          lines.push("  _(no widgets specified)_");
        } else {
          for (const w of widgetDefs) {
            const castType = WIDGET_CAST_MAP[w.kind] ?? "Widget";
            const widgetClass = WIDGET_CLASS_MAP[w.kind] ?? "FrameWidgetClass";
            lines.push(
              `  ${w.name} → ${widgetClass} (FindAnyWidget("${w.name}"))`
            );
          }
        }
        lines.push("");

        // Localization keys
        lines.push("### Localization Keys Generated");
        for (const entry of locEntries) {
          lines.push(`  #${entry.key} = "${entry.value}"`);
        }
        lines.push("");

        // Script output (inline)
        if (!basePath) {
          lines.push("### Generated Layout");
          lines.push("```");
          lines.push(layoutContent.trimEnd());
          lines.push("```");
          lines.push("");
          lines.push("### Generated Script");
          lines.push("```c");
          lines.push(scriptContent.trimEnd());
          lines.push("```");
          lines.push("");
          lines.push("### Generated Imageset");
          lines.push("```xml");
          lines.push(imagesetContent.trimEnd());
          lines.push("```");
          lines.push("");
          lines.push("### Generated Localization");
          lines.push("```xml");
          lines.push(locContent.trimEnd());
          lines.push("```");
          lines.push("");
        }

        // Next steps
        lines.push("### Next Steps");
        lines.push(`  1. Open ${name}.layout in Workbench Layout Editor`);
        lines.push(`  2. Customize widget positions and sizes`);
        lines.push(`  3. Add business logic to ${className}.c`);
        if (widgetDefs.some((w) => w.kind === "image")) {
          lines.push(`  4. Convert icon .png to .edds and update ${name}.imageset`);
        }

        return {
          content: [{ type: "text", text: lines.join("\n") }],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            { type: "text", text: `Error scaffolding UI: ${msg}` },
          ],
          isError: true,
        };
      }
    }
  );
}
