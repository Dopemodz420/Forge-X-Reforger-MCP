import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { logger } from "./utils/logger.js";

export interface Config {
  /** Path to "Arma Reforger Tools" installation */
  workbenchPath: string;
  /** Default project directory for project_browse */
  projectPath: string;
  /** Path to base game installation (auto-derived from workbenchPath) */
  gamePath: string;
  /** Optional path to a pre-extracted game data library (fully flattened prefabs).
   *  When set, game_duplicate checks here first before falling back to pak loose files.
   *  Set via ENFUSION_EXTRACTED_PATH env var. */
  extractedPath?: string;
  /** Optional path to an unpacked game data export (from ReforgerPakTool).
   *  Contains all game files as individual text files on disk (no decompression needed).
   *  Set via ENFUSION_EXPORT_PATH env var. */
  exportPath?: string;
  /** Directory containing scraped data index */
  dataDir: string;
  /** Directory containing mod pattern definitions */
  patternsDir: string;
  /** Workbench NET API host (default 127.0.0.1) */
  workbenchHost: string;
  /** Workbench NET API port (default 5780) */
  workbenchPort: number;
  /** Default addon folder name used when modName is not specified in tool calls.
   *  Automatically set at runtime when wb_launch opens a .gproj file.
   *  Can also be set via ENFUSION_DEFAULT_MOD env var as a static fallback. */
  defaultMod?: string;
  /** Path to the last .gproj opened by wb_launch. Persists across restarts. */
  lastProject?: string;
}

const DEFAULT_WORKBENCH_PATH =
  "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools";

const DEFAULTS: Config = {
  workbenchPath: DEFAULT_WORKBENCH_PATH,
  projectPath: join(homedir(), "Documents", "My Games", "ArmaReforgerWorkbench", "addons"),
  gamePath: resolve(DEFAULT_WORKBENCH_PATH, "..", "Arma Reforger"),
  dataDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data"
  ),
  patternsDir: resolve(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "data",
    "patterns"
  ),
  workbenchHost: "127.0.0.1",
  workbenchPort: 5780,
};

function loadJsonFile(path: string): Partial<Config> {
  try {
    if (!existsSync(path)) return {};
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as Partial<Config>;
  } catch (e) {
    // Distinguish read errors from parse errors so users can fix malformed JSON
    const detail = e instanceof SyntaxError
      ? `invalid JSON: ${e.message}`
      : String(e);
    logger.warn(`Failed to load config from ${path}: ${detail}`);
  }
  return {};
}

export function loadConfig(): Config {
  // 1. Start with defaults
  const config = { ...DEFAULTS };

  // 2. Package-local config file (new name first, legacy fallback)
  const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const localConfigPaths = [
    resolve(packageDir, "reforger-forge.config.json"),
    resolve(packageDir, "enfusion-mcp.config.json"),
  ];
  for (const path of localConfigPaths) {
    Object.assign(config, loadJsonFile(path));
  }

  // 3. User home config (new name first, legacy fallback)
  const homeConfigPaths = [
    resolve(homedir(), ".reforger-forge", "config.json"),
    resolve(homedir(), ".enfusion-mcp", "config.json"),
  ];
  for (const path of homeConfigPaths) {
    Object.assign(config, loadJsonFile(path));
  }

  // 4. Environment variables override everything
  if (process.env.ENFUSION_WORKBENCH_PATH) {
    config.workbenchPath = process.env.ENFUSION_WORKBENCH_PATH;
  }
  if (process.env.ENFUSION_PROJECT_PATH) {
    config.projectPath = process.env.ENFUSION_PROJECT_PATH;
  }
  if (process.env.ENFUSION_GAME_PATH) {
    config.gamePath = process.env.ENFUSION_GAME_PATH;
  }
  if (process.env.ENFUSION_EXTRACTED_PATH) {
    config.extractedPath = process.env.ENFUSION_EXTRACTED_PATH;
  }
  if (process.env.ENFUSION_EXPORT_PATH) {
    config.exportPath = process.env.ENFUSION_EXPORT_PATH;
  }
  if (process.env.ENFUSION_MCP_DATA_DIR) {
    config.dataDir = process.env.ENFUSION_MCP_DATA_DIR;
    // patternsDir is always <dataDir>/patterns unless explicitly set in a config file
    config.patternsDir = join(process.env.ENFUSION_MCP_DATA_DIR, "patterns");
  }
  if (process.env.ENFUSION_WORKBENCH_HOST) {
    config.workbenchHost = process.env.ENFUSION_WORKBENCH_HOST;
  }
  if (process.env.ENFUSION_WORKBENCH_PORT) {
    const port = parseInt(process.env.ENFUSION_WORKBENCH_PORT, 10);
    if (!isNaN(port) && port > 0 && port < 65536) {
      config.workbenchPort = port;
    }
  }
  if (process.env.ENFUSION_DEFAULT_MOD) {
    config.defaultMod = process.env.ENFUSION_DEFAULT_MOD;
  }

  // Auto-derive gamePath from workbenchPath if not explicitly set
  if (!process.env.ENFUSION_GAME_PATH && config.workbenchPath !== DEFAULT_WORKBENCH_PATH) {
    config.gamePath = resolve(config.workbenchPath, "..", "Arma Reforger");
  }

  logger.debug("Config loaded", config);
  return config;
}

/** State file for persisting last-opened project across MCP server restarts. */
const STATE_FILE = resolve(
  homedir(),
  ".reforger-forge",
  "state.json"
);

/** Save the last-opened .gproj path so wb_launch can reopen it next time. */
export function saveLastProject(gprojPath: string): void {
  // Never persist the internal EnfusionMCP standalone addon — it should never hijack the default project
  if (gprojPath.includes("EnfusionMCP")) {
    logger.debug(`Skipping saveLastProject for internal handler addon: ${gprojPath}`);
    return;
  }
  try {
    const dir = dirname(STATE_FILE);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(STATE_FILE, JSON.stringify({ lastProject: gprojPath }, null, 2), "utf-8");
    logger.info(`Saved last project: ${gprojPath}`);
  } catch (e) {
    logger.warn(`Failed to save last project: ${e}`);
  }
}

/** Load the last-opened .gproj path, or null if none saved. */
export function loadLastProject(): string | null {
  try {
    if (!existsSync(STATE_FILE)) return null;
    const data = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    if (data.lastProject && existsSync(data.lastProject)) {
      // Ignore stale standalone handler addon — it was the fallback before the fix and hijacks every launch
      if (data.lastProject.includes("EnfusionMCP")) {
        logger.info(`Ignoring stale lastProject pointing at EnfusionMCP: ${data.lastProject}`);
        return null;
      }
      return data.lastProject;
    }
  } catch { /* ignore */ }
  return null;
}
