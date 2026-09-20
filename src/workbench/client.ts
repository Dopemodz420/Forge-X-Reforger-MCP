/**
 * TCP client for the Workbench NET API.
 *
 * Each rawCall() opens a fresh TCP connection, sends one request, reads the
 * response, and closes the socket (protocol requirement).
 *
 * call() wraps rawCall() with auto-launch: if Workbench isn't running,
 * it installs handler scripts, launches the exe, waits for the NET API,
 * and retries the original call.
 */

import { Socket } from "node:net";
import { existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, execSync } from "node:child_process";
import { encodeRequest, decodeResponse } from "./protocol.js";
import { logger } from "../utils/logger.js";
import type { Config } from "../config.js";
import { generateGproj } from "../templates/gproj.js";
import { saveLastProject, loadLastProject } from "../config.js";

const DEFAULT_CLIENT_ID = "EnfusionMCP";
const DEFAULT_TIMEOUT_MS = 10_000;
/** Maximum response size (10 MB) to prevent memory exhaustion from malformed/unexpected data. */
const MAX_RESPONSE_SIZE = 10 * 1024 * 1024;
const WORKBENCH_EXE = "ArmaReforgerWorkbenchSteamDiag.exe";
const WORKBENCH_SUBDIR = "Workbench";
const HANDLER_FOLDER = "EnfusionMCP";
const LAUNCH_POLL_INTERVAL_MS = 3_000;
const LAUNCH_TIMEOUT_MS = 90_000;
/** Delay after killing Workbench before relaunching, to let the port release. */
const KILL_SETTLE_MS = 3_000;
/** How long to wait for Workbench to recompile handler scripts after installation. */
const HANDLER_RECOMPILE_TIMEOUT_MS = 30_000;
/** Interval between polls while waiting for handler script recompilation. */
const HANDLER_RECOMPILE_POLL_MS = 2_000;

export type WorkbenchMode = "edit" | "play" | "unknown";

export interface DiagnosticReport {
  host: string;
  port: number;
  workbenchExe: { path: string; exists: boolean } | null;
  projectPath: { path: string; exists: boolean } | null;
  defaultMod: string | null;
  bundledScripts: { path: string; exists: boolean };
  standaloneAddon: { path: string; exists: boolean; fileCount: number };
  installedMods: Array<{ modDir: string; handlerDir: string; fileCount: number; hasScriptsModule: boolean }>;
  /** Result of the NET API probe. */
  netApi: "up_with_handlers" | "up_no_handlers" | "refused" | "timeout" | "error";
  netApiError?: string;
}

export interface WorkbenchState {
  connected: boolean;
  mode: WorkbenchMode;
  lastUpdated: number;
}

export interface WorkbenchCallOptions {
  /** Timeout in milliseconds (default 10 000). */
  timeout?: number;
  /** Skip auto-launch on connection failure (used internally by ping). */
  skipAutoLaunch?: boolean;
  /**
   * Return a `status: "error"` response instead of throwing.
   *
   * Only for calls whose failure is genuinely optional — a secondary lookup the
   * caller degrades gracefully around (e.g. reading a position to enrich a result
   * that is still useful without it). Never use it for the primary action of a
   * tool: that is exactly how a failed mutation gets reported as success.
   */
  tolerateErrorStatus?: boolean;
}

export class WorkbenchError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "CONNECTION_REFUSED"
      | "TIMEOUT"
      | "PROTOCOL_ERROR"
      | "API_ERROR"
      | "LAUNCH_FAILED" = "API_ERROR"
  ) {
    super(message);
    this.name = "WorkbenchError";
  }
}

export class WorkbenchClient {
  private launchPromise: Promise<void> | null = null;
  private _state: WorkbenchState = { connected: false, mode: "unknown", lastUpdated: 0 };

  /** Current cached connection state. Updated after every successful call. */
  get state(): Readonly<WorkbenchState> {
    return this._state;
  }

  constructor(
    private readonly host: string,
    private readonly port: number,
    private readonly config?: Config,
    private readonly clientId: string = DEFAULT_CLIENT_ID
  ) {}

  /**
   * Call a Workbench NET API function.
   * Auto-launches Workbench if not running.
   */
  async call<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    try {
      return this.finishCall(await this.rawCall<T>(apiFunc, params, options), options);
    } catch (err) {
      if (err instanceof WorkbenchError) {
        if (err.code === "CONNECTION_REFUSED" || err.code === "TIMEOUT" || err.code === "PROTOCOL_ERROR") {
          this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
        }
        if (!options.skipAutoLaunch && this.config) {
          if (err.code === "CONNECTION_REFUSED") {
            // Workbench not running — install handlers, launch, retry
            logger.info(`Workbench not running, auto-launching...`);
            await this.ensureRunning();
            return this.finishCall(await this.rawCall<T>(apiFunc, params, options), options);
          }
          if (err.code === "API_ERROR" && /not existing|Undefined API func/i.test(err.message)) {
            // Try bootstrap fallback first (WorkbenchGameCommon handlers that work at launcher without WorldEditor).
            // Distinct class names (PingBootstrap) avoid duplicate-class when both modules are active.
            const bootstrapMap: Record<string, string> = {
              EMCP_WB_Ping: "EMCP_WB_PingBootstrap",
              EMCP_WB_GetState: "EMCP_WB_GetStateBootstrap",
            };
            const bootstrap = bootstrapMap[apiFunc];
            if (bootstrap) {
              try {
                return this.finishCall(
                  await this.rawCall<T>(bootstrap, params, { ...options, skipAutoLaunch: true }),
                  options
                );
              } catch {
                // bootstrap not available — fall through to recovery
              }
            }
            // Workbench is running but our custom handler scripts aren't compiled.
            // This happens when the user opened Workbench manually, or when handlers
            // were cleaned up but Workbench kept running.
            logger.info(`Handler scripts not loaded in Workbench, recovering...`);
            await this.recoverMissingHandlers();
            try {
              return this.finishCall(await this.rawCall<T>(apiFunc, params, options), options);
            } catch (retryErr) {
              // Still not registered after reinstall + recompile → new handler class requires restart.
              // Workbench builds NET API dispatch table at process start.
              if (
                retryErr instanceof WorkbenchError &&
                /not existing|Undefined API func/i.test(retryErr.message)
              ) {
                throw new WorkbenchError(
                  `Workbench does not expose "${apiFunc}" even after reinstalling and ` +
                    `recompiling the handler scripts. Workbench registers NET API handlers ` +
                    `when the process starts, so a handler class that is new since Workbench ` +
                    `launched will not appear until Workbench is restarted — the script ` +
                    `compiles cleanly and the other handlers keep working, so this does not ` +
                    `look like a registration problem. Restart Workbench, then retry.`,
                  "API_ERROR"
                );
              }
              throw retryErr;
            }
          }
        }
      }
      throw err;
    }
  }

  /**
   * Record connection state from a successful transport round-trip, then surface an
   * in-band handler failure as a thrown error.
   *
   * The NET API returns transport-level "Ok" even when the handler itself failed —
   * 18 of the Enforce handlers report failure in-band by setting `status: "error"`.
   * Every return path in call() goes through here so a retry path cannot skip it.
   */
  private finishCall<T>(result: T, options: WorkbenchCallOptions): T {
    this._state.connected = true;
    this._state.lastUpdated = Date.now();
    this.extractMode(result);

    if (!options.tolerateErrorStatus) {
      const record = result as unknown as Record<string, unknown> | null;
      if (record && record.status === "error") {
        const message =
          typeof record.message === "string" && record.message.trim() !== ""
            ? record.message
            : "Workbench handler reported an error without a message.";
        throw new WorkbenchError(message, "API_ERROR");
      }
    }

    return result;
  }

  /**
   * Explicitly refresh cached state by calling EMCP_WB_GetState.
   */
  async refreshState(): Promise<WorkbenchState> {
    try {
      await this.call<Record<string, unknown>>("EMCP_WB_GetState");
      return { ...this._state };
    } catch {
      this._state = { connected: false, mode: "unknown", lastUpdated: Date.now() };
      return { ...this._state };
    }
  }

  /**
   * Ensure Workbench is running. Installs handler scripts, launches exe,
   * and waits for NET API. Safe to call concurrently — deduplicates launches.
   * @param gprojPath Optional .gproj file path to open directly (skips launcher).
   */
  async ensureRunning(gprojPath?: string): Promise<void> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot auto-launch Workbench.", "LAUNCH_FAILED");
    }

    // Deduplicate concurrent calls — all callers await the same promise
    if (this.launchPromise) {
      return this.launchPromise;
    }

    const promise = this.launchWorkbench(gprojPath).finally(() => {
      // Only clear if this is still the active promise (guards against re-entrant calls)
      if (this.launchPromise === promise) {
        this.launchPromise = null;
      }
    });

    this.launchPromise = promise;
    return promise;
  }

  /**
   * Quick health check. Returns true if Workbench responds, false otherwise.
   * Does NOT auto-launch.
   *
   * Uses our custom EMCP_WB_Ping handler (not the built-in GetLoadedProjects)
   * so the launch poller only succeeds once the mod's handler scripts have
   * finished compiling — avoiding a race where the NET API socket is up but
   * custom handlers aren't loaded yet.
   */
  async ping(): Promise<boolean> {
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      return true;
    } catch (e) {
      // Fallback to bootstrap ping (WorkbenchGameCommon) which loads at launcher without WorldEditor.
      // Distinct class name avoids duplicate-class when both modules are active.
      if (e instanceof WorkbenchError && e.code === "API_ERROR" && /not existing/i.test(e.message)) {
        try {
          await this.rawCall("EMCP_WB_PingBootstrap", {}, { timeout: 3000, skipAutoLaunch: true });
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
  }

  /**
   * Remove injected handler scripts from a mod's directory.
   * Call this after Workbench work is done, before publishing the mod.
   * Deletes Scripts/WorkbenchGame/EnfusionMCP/ from the mod.
   * Safe to call even if scripts were never injected.
   */
  cleanupHandlerScripts(modDir: string): boolean {
    const handlerDir = resolve(modDir, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bootstrapDir = resolve(modDir, "Scripts", "WorkbenchGameCommon", HANDLER_FOLDER);
    let cleaned = false;
    for (const dir of [handlerDir, bootstrapDir]) {
      if (!existsSync(dir)) continue;
      try {
        rmSync(dir, { recursive: true, force: true });
        logger.info(`Removed handler scripts from ${dir}`);
        cleaned = true;
      } catch (e) {
        logger.warn(`Failed to clean up handler scripts at ${dir}: ${e}`);
      }
    }
    if (!cleaned) {
      logger.info(`Handler scripts not found at ${handlerDir}`);
      return false;
    }
    // Clean up empty parent dirs
    for (const wbDir of [join(modDir, "Scripts", "WorkbenchGame"), join(modDir, "Scripts", "WorkbenchGameCommon")]) {
      try {
        if (existsSync(wbDir) && readdirSync(wbDir).length === 0) {
          rmSync(wbDir);
        }
      } catch { /* ignore */ }
    }
    return true;
  }

  /**
   * Collect a diagnostic snapshot: config, file system, and NET API state.
   * Does NOT auto-launch Workbench or throw — always returns a report.
   */
  async diagnose(): Promise<DiagnosticReport> {
    // --- Config info ---
    const host = this.host;
    const port = this.port;
    const defaultMod = this.config?.defaultMod ?? null;

    // Workbench exe
    let workbenchExe: DiagnosticReport["workbenchExe"] = null;
    if (this.config) {
      const exePath = this.findWorkbenchExe();
      const candidate =
        exePath ??
        join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
      workbenchExe = { path: candidate, exists: existsSync(candidate) };
    }

    // Project path
    let projectPathInfo: DiagnosticReport["projectPath"] = null;
    if (this.config?.projectPath) {
      projectPathInfo = {
        path: this.config.projectPath,
        exists: existsSync(this.config.projectPath),
      };
    }

    // Bundled handler scripts (inside this package)
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundledScripts = { path: bundledDir, exists: existsSync(bundledDir) };

    // Standalone addon
    const standaloneBase = this.config?.projectPath
      ? join(this.config.projectPath, HANDLER_FOLDER)
      : join("<unknown>", HANDLER_FOLDER);
    const standaloneScriptsDir = join(standaloneBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const standaloneFileCount = existsSync(standaloneScriptsDir)
      ? readdirSync(standaloneScriptsDir).filter((f) => f.endsWith(".c")).length
      : 0;
    const standaloneAddon = {
      path: standaloneBase,
      exists: existsSync(standaloneBase),
      fileCount: standaloneFileCount,
    };

    // Scan project path for mods that have handler scripts installed
    const installedMods: DiagnosticReport["installedMods"] = [];
    if (this.config?.projectPath && existsSync(this.config.projectPath)) {
      try {
        for (const entry of readdirSync(this.config.projectPath, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          if (entry.name === HANDLER_FOLDER) continue; // standalone, covered above
          const handlerDir = join(this.config.projectPath, entry.name, "Scripts", "WorkbenchGame", HANDLER_FOLDER);
          if (existsSync(handlerDir)) {
            const fileCount = readdirSync(handlerDir).filter((f) => f.endsWith(".c")).length;
            const gprojFile = readdirSync(join(this.config.projectPath, entry.name)).find(f => f.endsWith(".gproj"));
            const hasScriptsModule = gprojFile
              ? this.gprojHasScriptsModule(join(this.config.projectPath, entry.name, gprojFile))
              : false;
            installedMods.push({ modDir: join(this.config.projectPath, entry.name), handlerDir, fileCount, hasScriptsModule });
          }
        }
      } catch { /* ignore */ }
    }

    // --- NET API probe ---
    let netApi: DiagnosticReport["netApi"] = "refused";
    let netApiError: string | undefined;
    try {
      await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
      netApi = "up_with_handlers";
    } catch (err) {
      // Fallback to bootstrap ping (WorkbenchGameCommon) which works at launcher without WorldEditor
      if (err instanceof WorkbenchError && err.code === "API_ERROR" && /not existing/i.test(err.message)) {
        try {
          await this.rawCall("EMCP_WB_PingBootstrap", {}, { timeout: 3000, skipAutoLaunch: true });
          netApi = "up_with_handlers";
          netApiError = undefined;
        } catch (e2) {
          if (e2 instanceof WorkbenchError) {
            netApiError = e2.message;
            if (e2.code === "API_ERROR" && /not existing/i.test(e2.message)) {
              netApi = "up_no_handlers";
            } else {
              netApi = "error";
            }
          } else {
            netApi = "error";
            netApiError = String(e2);
          }
        }
      } else if (err instanceof WorkbenchError) {
        netApiError = err.message;
        if (err.code === "CONNECTION_REFUSED") {
          netApi = "refused";
        } else if (err.code === "TIMEOUT") {
          netApi = "timeout";
        } else if (err.code === "API_ERROR" && /not existing/i.test(err.message)) {
          netApi = "up_no_handlers";
        } else {
          netApi = "error";
        }
      } else {
        netApi = "error";
        netApiError = String(err);
      }
    }

    return {
      host,
      port,
      workbenchExe,
      projectPath: projectPathInfo,
      defaultMod,
      bundledScripts,
      standaloneAddon,
      installedMods,
      netApi,
      netApiError,
    };
  }

  /**
   * Remove the standalone EnfusionMCP addon directory if it exists.
   * This prevents duplicate class name errors when handler scripts are injected
   * into a user's mod and the standalone folder is also present in the addons dir.
   */
  private cleanupStandaloneAddon(): void {
    const fallbackBase = this.config?.projectPath;
    if (!fallbackBase) return;
    const standaloneDir = join(fallbackBase, HANDLER_FOLDER);
    if (!existsSync(standaloneDir)) return;
    try {
      rmSync(standaloneDir, { recursive: true, force: true });
      logger.info(`Removed leftover standalone addon: ${standaloneDir}`);
    } catch (e) {
      logger.warn(`Failed to remove standalone addon: ${e}`);
    }
  }

  toString(): string {
    return `WorkbenchClient(${this.host}:${this.port})`;
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  /** Extract mode from a response object if it contains a `mode` field. */
  private extractMode(result: unknown): void {
    if (result && typeof result === "object" && "mode" in result) {
      const mode = (result as Record<string, unknown>).mode;
      if (mode === "edit") {
        this._state.mode = "edit";
      } else if (mode === "play" || mode === "game") {
        // Scripts return "game" when in play mode (WorldEditorAPI unavailable)
        this._state.mode = "play";
      }
      // "no_world_editor" and unrecognised values leave mode as-is (stays "unknown")
    }
  }

  /**
   * Recover from "not existing Net API function" errors.
   * Workbench is running but our custom handler scripts aren't compiled.
   * Installs handlers into the mod directory and waits for Workbench to
   * auto-recompile them — without killing the running Workbench process.
   *
   * Previous behaviour killed Workbench with taskkill, which broke other
   * tools (e.g. the Enfusion Blender plugin) that share the same NET API.
   */
  private async recoverMissingHandlers(): Promise<void> {
    if (!this.config) {
      throw new WorkbenchError("No config provided — cannot recover handlers.", "LAUNCH_FAILED");
    }

    // Inject into the currently-open mod — respect explicit lastProject/defaultMod, not just alphabetical fallback.
    // Priority: lastProject (user's last wb_launch) > findFallbackGproj (most-recent real mod)
    const recoveryGproj = loadLastProject() || this.findFallbackGproj();
    if (recoveryGproj) {
      // Auto-patch missing Modules { "scripts" } so handlers can compile in the user's real mod
      // instead of silently falling back to the standalone EnfusionMCP addon.
      if (!this.gprojHasScriptsModule(recoveryGproj)) {
        logger.info(`Patching recovery gproj to add Modules { "scripts" }: ${recoveryGproj}`);
        this.ensureGprojHasScriptsModule(recoveryGproj);
      }
      if (this.gprojHasScriptsModule(recoveryGproj)) {
        this.installHandlerScripts(dirname(recoveryGproj), true);
        this.cleanupStandaloneAddon();
      } else {
        logger.warn(
          `Recovery mod .gproj still missing Modules { "scripts" } after patch: ${recoveryGproj}. ` +
          `Falling back to standalone handler addon.`
        );
        this.installHandlerScripts(undefined, true);
      }
    } else {
      logger.warn("No recovery gproj found — installing standalone handler addon");
      this.installHandlerScripts(undefined, true);
    }

    // Wait for Workbench to detect the new files and recompile scripts.
    // Workbench watches its script directories and recompiles automatically.
    // Poll with our custom EMCP_WB_Ping handler — it only succeeds once
    // the handler scripts are compiled and registered.
    logger.info("Handler scripts installed. Waiting for Workbench to recompile...");
    const deadline = Date.now() + HANDLER_RECOMPILE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, HANDLER_RECOMPILE_POLL_MS));
      if (await this.ping()) {
        logger.info("Handler scripts compiled and loaded.");
        return;
      }
    }

    throw new WorkbenchError(
      `Handler scripts were installed but Workbench did not recompile them within ` +
        `${HANDLER_RECOMPILE_TIMEOUT_MS / 1000}s. Try recompiling scripts manually in ` +
        `Workbench (Plugins > Reload Scripts) or restart Workbench.`,
      "LAUNCH_FAILED"
    );
  }

  /**
   * Kill any running Workbench process. Windows-only (taskkill).
   * Safe to call even if Workbench isn't running.
   */
  private killWorkbench(): void {
    try {
      execSync(`taskkill /IM ${WORKBENCH_EXE} /F`, { stdio: "ignore" });
      logger.info("Killed running Workbench process.");
    } catch {
      // Process might not be running — ignore
    }
  }

  private async launchWorkbench(gprojPath?: string): Promise<void> {
    // 1. Check if already running (maybe it came up between the failed call and now)
    if (await this.ping()) {
      logger.info("Workbench is already running.");
      return;
    }

    // 2. Resolve the target .gproj and inject handler scripts into that mod.
    //    Priority: explicit gprojPath > last saved project > findFallbackGproj > standalone addon
    let resolvedGproj = gprojPath || loadLastProject() || this.findFallbackGproj();
    if (resolvedGproj && !gprojPath) {
      // Verify the saved/fallback gproj still exists
      if (!existsSync(resolvedGproj)) {
        logger.info(`Saved project no longer exists: ${resolvedGproj}`);
        resolvedGproj = null;
      }
    }
    if (resolvedGproj) {
      // Check if the mod's .gproj declares Modules { "scripts" }.
      // Without it, Workbench skips script compilation and our handler scripts
      // (NetApiHandler subclasses) are never registered with the NET API.
      // GREATEST UX: auto-patch the gproj instead of silently hijacking EnfusionMCP.
      if (!this.gprojHasScriptsModule(resolvedGproj)) {
        logger.info(`Patching ${resolvedGproj} to add Modules { "scripts" } so handlers can compile in your mod`);
        this.ensureGprojHasScriptsModule(resolvedGproj);
      }
      if (this.gprojHasScriptsModule(resolvedGproj)) {
        this.installHandlerScripts(dirname(resolvedGproj));
        // Remove any leftover standalone addon to prevent duplicate class errors.
        this.cleanupStandaloneAddon();
      } else {
        logger.warn(
          `Mod .gproj still missing Modules { "scripts" } after patch: ${resolvedGproj}. ` +
          `Falling back to standalone addon.`
        );
        resolvedGproj = null;
      }
    }
    if (!resolvedGproj) {
      // No project found after patch attempt — use standalone addon as absolute last resort.
      // This only happens when projectPath is empty or every gproj is unpatchable.
      // The standalone addon is intentionally excluded from fallback scans and state.
      logger.warn("No valid project gproj found — falling back to standalone EnfusionMCP handler addon (last resort)");
      this.installHandlerScripts();
      const fallbackBase = this.config?.projectPath;
      if (fallbackBase) {
        const standaloneGproj = join(fallbackBase, HANDLER_FOLDER, `${HANDLER_FOLDER}.gproj`);
        if (existsSync(standaloneGproj)) {
          resolvedGproj = standaloneGproj;
        }
      }
    }

    // 3. Find executable
    const exePath = this.findWorkbenchExe();
    if (!exePath) {
      const wbPath = this.config?.workbenchPath ?? "(not configured)";
      throw new WorkbenchError(
        `Cannot find ${WORKBENCH_EXE}. Install Arma Reforger Tools from Steam, ` +
          `or set ENFUSION_WORKBENCH_PATH. Searched:\n` +
          `  - ${join(wbPath, WORKBENCH_SUBDIR, WORKBENCH_EXE)}\n` +
          `  - ${join(wbPath, WORKBENCH_EXE)}`,
        "LAUNCH_FAILED"
      );
    }

    // 4. Spawn with -gproj to skip the launcher
    const args: string[] = [];
    if (resolvedGproj) {
      args.push("-gproj", resolvedGproj);
    }

    // Use the game install directory as CWD so Workbench finds base game addons
    // (data/ArmaReforger.gproj with GUID 58D0FB3206B6F859) via ./addons resolution.
    const cwd = this.findGameDir() || dirname(exePath);

    logger.info(`Launching Workbench: ${exePath}${args.length ? ` ${args.join(" ")}` : ""} (cwd: ${cwd})`);
    const proc = spawn(exePath, args, {
      detached: true,
      stdio: "ignore",
      cwd,
    });
    proc.unref();

    // 5. Wait for NET API — track the last error type so the timeout message is actionable
    const deadline = Date.now() + LAUNCH_TIMEOUT_MS;
    let lastErrorCode: WorkbenchError["code"] | undefined;
    while (Date.now() < deadline) {
      try {
        await this.rawCall("EMCP_WB_Ping", {}, { timeout: 3000, skipAutoLaunch: true });
        this._state.connected = true;
        this._state.lastUpdated = Date.now();
        logger.info("Workbench NET API is responding.");

        // Force edit mode on startup — Workbench may restore a stale game-mode
        // session from the previous close. SwitchToEditMode is idempotent (no-op
        // if already in edit mode) and prevents the stuck-in-game-mode issue.
        try {
          await this.rawCall("EMCP_WB_EditorControl", { action: "stop" }, { timeout: 5000, skipAutoLaunch: true });
          logger.info("Forced edit mode on startup.");
        } catch {
          // Best-effort — if this fails, the user can call wb_stop manually.
          logger.debug("Could not force edit mode on startup (non-fatal).");
        }

        // Persist the project path so next launch reopens the same project
        if (resolvedGproj) {
          saveLastProject(resolvedGproj);
        }
        return;
      } catch (err) {
        if (err instanceof WorkbenchError) {
          lastErrorCode = err.code;
          logger.debug(`Workbench poll (${err.code}): ${err.message}`);
        }
      }
      await new Promise((r) => setTimeout(r, LAUNCH_POLL_INTERVAL_MS));
    }

    // Build a specific diagnostic based on what was failing at timeout.
    // CONNECTION_REFUSED = NET API port never opened → NET API likely disabled.
    // API_ERROR = NET API is up but EMCP_WB_Ping isn't registered → handler scripts
    //             didn't compile (project has script errors, or wrong mod directory).
    let hint: string;
    if (lastErrorCode === "API_ERROR") {
      hint =
        `Workbench NET API responded but handler scripts did not load. ` +
        `Check for script compilation errors in Workbench (Script Editor). ` +
        `Fix any errors in the project's scripts so the EnfusionMCP handlers can compile, ` +
        `then try again.`;
    } else {
      hint =
        `NET API port never responded. Ensure NET API is enabled in Workbench: ` +
        `File > Options > General > Net API (checkbox must be on).`;
    }

    throw new WorkbenchError(
      `Workbench launched but did not connect within ${LAUNCH_TIMEOUT_MS / 1000}s.\n\n${hint}`,
      "LAUNCH_FAILED"
    );
  }

  private findWorkbenchExe(): string | null {
    if (!this.config) return null;
    const subPath = join(this.config.workbenchPath, WORKBENCH_SUBDIR, WORKBENCH_EXE);
    if (existsSync(subPath)) return subPath;

    const rootPath = join(this.config.workbenchPath, WORKBENCH_EXE);
    if (existsSync(rootPath)) return rootPath;

    return null;
  }

  /**
   * Check if a .gproj file declares Modules { "scripts" }.
   * Without this, Workbench skips script compilation and handler scripts
   * (NetApiHandler subclasses) are never registered with the NET API.
   * Handles both Enfusion text format (Modules { "scripts" }) and JSON format ("modules": ["scripts"]).
   */
  private gprojHasScriptsModule(gprojPath: string): boolean {
    try {
      const content = readFileSync(gprojPath, "utf-8");
      // Enfusion text format
      if (/Modules\s*\{[^}]*"scripts"/.test(content)) return true;
      // JSON format (e.g. Party-GroupSystem addon.gproj)
      if (/"modules"\s*:\s*\[[^\]]*"scripts"/i.test(content)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Ensure a .gproj declares Modules { "scripts" } so handler scripts can compile.
   * If missing, patches the file in-place (creates backup-like idempotent insert).
   * Returns true if the file now has the module (was present or was patched).
   */
  private ensureGprojHasScriptsModule(gprojPath: string): boolean {
    if (this.gprojHasScriptsModule(gprojPath)) return true;
    try {
      let content = readFileSync(gprojPath, "utf-8");
      // JSON format (Party-GroupSystem etc.)
      if (content.trim().startsWith("{")) {
        try {
          const json = JSON.parse(content);
          if (Array.isArray(json.modules) && json.modules.includes("scripts")) return true;
          json.modules = Array.isArray(json.modules) ? [...json.modules, "scripts"] : ["scripts"];
          writeFileSync(gprojPath, JSON.stringify(json, null, 2), "utf-8");
          logger.info(`Patched JSON ${gprojPath} to add "scripts" to modules`);
          return true;
        } catch { /* fall through to text handling */ }
      }
      // If a Modules block exists but lacks "scripts", inject it
      if (/Modules\s*\{/.test(content)) {
        content = content.replace(/Modules\s*\{([^}]*)\}/, (_m, inner: string) => {
          const trimmed = inner.trim();
          const needsComma = trimmed.length > 0 && !trimmed.endsWith(",");
          return `Modules {\n  ${trimmed}${needsComma ? "," : ""}${trimmed ? " " : ""}"scripts"\n }`;
        });
      } else if (/Dependencies\s*\{[^}]*\}/.test(content)) {
        // Insert Modules block right after Dependencies
        content = content.replace(/(Dependencies\s*\{[^}]*\})/, `$1\n Modules {\n  "scripts"\n }`);
      } else if (/GameProject\s*\{/.test(content)) {
        // Fallback: insert after opening GameProject {
        content = content.replace(/(GameProject\s*\{)/, `$1\n Modules {\n  "scripts"\n }`);
      } else {
        return false;
      }
      writeFileSync(gprojPath, content, "utf-8");
      logger.info(`Patched ${gprojPath} to add Modules { "scripts" } so EnfusionMCP handlers can compile`);
      return true;
    } catch (e) {
      logger.warn(`Failed to patch ${gprojPath} with Modules { "scripts" }: ${e}`);
      return false;
    }
  }

  /**
   * Find a .gproj to pass via -gproj so Workbench skips the launcher.
   * Prefers config.defaultMod if set; otherwise picks the most-recently-modified
   * addon that already has Modules { "scripts" }. Skips the internal EnfusionMCP
   * standalone addon so it never hijacks the default project.
   * Scans for any .gproj in each addon folder (name need not match folder).
   */
  private findFallbackGproj(): string | null {
    const findGprojInDir = (dir: string): string | null => {
      try {
        for (const f of readdirSync(dir, { withFileTypes: true })) {
          if (!f.isDirectory() && f.name.endsWith(".gproj")) {
            return join(dir, f.name);
          }
        }
      } catch { /* ignore */ }
      return null;
    };

    try {
      const addonsDir = this.config?.projectPath;
      if (!addonsDir || !existsSync(addonsDir)) return null;

      // Prefer the configured default mod over scan
      const preferred = this.config?.defaultMod;
      if (preferred && preferred !== HANDLER_FOLDER) {
        const gprojPath = findGprojInDir(join(addonsDir, preferred));
        if (gprojPath) {
          logger.info(`Using defaultMod gproj to skip launcher: ${gprojPath}`);
          return gprojPath;
        }
      }

      // Gather all candidates, explicitly skipping the internal handler addon
      type Candidate = { gprojPath: string; mtime: number; hasScripts: boolean };
      const candidates: Candidate[] = [];
      for (const entry of readdirSync(addonsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (entry.name === HANDLER_FOLDER) continue; // never auto-pick the internal addon
        // Skip obvious non-mod dirs (exports, etc.) that lack a .gproj — findGprojInDir will return null
        const gprojPath = findGprojInDir(join(addonsDir, entry.name));
        if (!gprojPath) continue;
        // Use mtime to prefer the mod the user touched most recently
        let mtime = 0;
        try { mtime = require("node:fs").statSync(gprojPath).mtimeMs; } catch { /* ignore */ }
        const hasScripts = this.gprojHasScriptsModule(gprojPath);
        candidates.push({ gprojPath, mtime, hasScripts });
      }

      if (candidates.length === 0) return null;

      // Prefer candidates that already have Modules { "scripts" } — they can compile handlers immediately
      const withScripts = candidates.filter(c => c.hasScripts);
      const pool = withScripts.length > 0 ? withScripts : candidates;
      // Most recently modified first
      pool.sort((a, b) => b.mtime - a.mtime);
      const chosen = pool[0];
      logger.info(`Using fallback gproj to skip launcher: ${chosen.gprojPath} (hasScripts=${chosen.hasScripts})`);
      return chosen.gprojPath;
    } catch { /* ignore */ }
    return null;
  }

  /**
   * Derive the Arma Reforger game install directory.
   * Checks ENFUSION_GAME_PATH env var first, then walks up from workbenchPath.
   * workbenchPath may point to the Tools root OR the Workbench subdirectory,
   * so we try both one and two levels up.
   */
  private findGameDir(): string | null {
    // Explicit env var takes priority
    const envGamePath = process.env.ENFUSION_GAME_PATH;
    if (envGamePath && existsSync(join(envGamePath, "addons"))) {
      logger.info(`Using game directory from ENFUSION_GAME_PATH: ${envGamePath}`);
      return envGamePath;
    }

    if (!this.config) return null;

    // Config gamePath (set in reforger-forge.config.json)
    if (this.config.gamePath && existsSync(join(this.config.gamePath, "addons"))) {
      logger.info(`Using game directory from config: ${this.config.gamePath}`);
      return this.config.gamePath;
    }

    // Derive from workbenchPath — may be on a different drive than the game
    const toolsDir = this.config.workbenchPath;
    const candidates = [
      resolve(toolsDir, "..", "Arma Reforger"),
      resolve(toolsDir, "..", "ArmaReforger"),
      resolve(toolsDir, "..", "..", "Arma Reforger"),
      resolve(toolsDir, "..", "..", "ArmaReforger"),
    ];
    for (const candidate of candidates) {
      if (existsSync(join(candidate, "addons"))) {
        logger.info(`Using game directory as CWD: ${candidate}`);
        return candidate;
      }
    }
    logger.warn("Could not find Arma Reforger game directory. Workbench may fail to resolve base game addon.");
    return null;
  }

  /**
   * Copy handler scripts into a mod directory so they compile as part of that mod.
   * Installs WorkbenchGame handlers (full entity/world tools) plus WorkbenchGameCommon
   * bootstrap handlers (Ping/GetState that work at launcher without WorldEditor).
   * The bootstrap uses distinct class names (EMCP_WB_PingBootstrap) to avoid
   * duplicate-class compile when both modules are active.
   * If no modDir given, installs to default project path (standalone, less useful).
   */
  private installHandlerScripts(modDir?: string, force = false): void {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    const bundledDir = join(packageRoot, "mod", "Scripts", "WorkbenchGame", HANDLER_FOLDER);
    const bundledBootstrapDir = join(packageRoot, "mod", "Scripts", "WorkbenchGameCommon", HANDLER_FOLDER);
    if (!existsSync(bundledDir)) {
      logger.warn("Bundled handler scripts not found in package.");
      return;
    }

    const fallbackBase = this.config?.projectPath;
    if (!modDir && !fallbackBase) {
      logger.warn("No modDir or projectPath configured — cannot install handler scripts.");
      return;
    }
    const isFallback = !modDir;
    const targetBase = modDir || join(fallbackBase!, HANDLER_FOLDER);
    const targetScriptsDir = join(targetBase, "Scripts", "WorkbenchGame", HANDLER_FOLDER);

    // Always overwrite handler scripts to ensure they match the current MCP toolset version.
    // Previously this skipped when EMCP_WB_Ping.c existed, causing stale handlers after updates.


    logger.info(`Installing handler scripts to ${targetScriptsDir}`);
    mkdirSync(targetScriptsDir, { recursive: true });

    const files = readdirSync(bundledDir).filter((f) => f.endsWith(".c"));
    try {
      for (const file of files) {
        copyFileSync(join(bundledDir, file), join(targetScriptsDir, file));
      }
    } catch (e) {
      // Partial installation — clean up to avoid broken state on next attempt
      logger.error(`Failed to install handler scripts, rolling back: ${e}`);
      try {
        rmSync(targetScriptsDir, { recursive: true, force: true });
      } catch { /* best-effort cleanup */ }
      throw e;
    }

    logger.info(`Installed ${files.length} handler scripts.`);

    // Also install bootstrap handlers to WorkbenchGameCommon (launcher-safe Ping/GetState).
    // Distinct class names (EMCP_WB_PingBootstrap) guarantee no duplicate-class when both modules are active.
    if (existsSync(bundledBootstrapDir)) {
      const targetBootstrapDir = join(targetBase, "Scripts", "WorkbenchGameCommon", HANDLER_FOLDER);
      try {
        mkdirSync(targetBootstrapDir, { recursive: true });
        const bootFiles = readdirSync(bundledBootstrapDir).filter((f) => f.endsWith(".c"));
        for (const file of bootFiles) {
          copyFileSync(join(bundledBootstrapDir, file), join(targetBootstrapDir, file));
        }
        logger.info(`Installed ${bootFiles.length} bootstrap handlers to ${targetBootstrapDir}`);
      } catch (e) {
        logger.warn(`Failed to install bootstrap handlers: ${e}`);
        // Non-fatal — main handlers still installed
      }
    }

    // When using the standalone fallback path, also write a .gproj so Workbench
    // treats the directory as a loadable addon and compiles the handler scripts.
    if (isFallback) {
      const gprojPath = join(targetBase, `${HANDLER_FOLDER}.gproj`);
      if (!existsSync(gprojPath)) {
        const gprojContent = generateGproj({ name: HANDLER_FOLDER, title: "EnfusionMCP Handlers" });
        writeFileSync(gprojPath, gprojContent, "utf-8");
        logger.info(`Created standalone addon .gproj at ${gprojPath}`);
      }
    }
  }

  /**
   * Raw TCP call — no auto-launch, no retry.
   */
  private rawCall<T = Record<string, unknown>>(
    apiFunc: string,
    params: Record<string, unknown> = {},
    options: WorkbenchCallOptions = {}
  ): Promise<T> {
    const timeout = options.timeout ?? DEFAULT_TIMEOUT_MS;
    const requestBuf = encodeRequest(this.clientId, apiFunc, params);

    return new Promise<T>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;

      const socket = new Socket();

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          cleanup();
          socket.destroy();
          reject(
            new WorkbenchError(
              `Workbench call "${apiFunc}" timed out after ${timeout}ms`,
              "TIMEOUT"
            )
          );
        }
      }, timeout);

      const cleanup = () => {
        clearTimeout(timer);
        socket.removeAllListeners();
      };

      socket.on("error", (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ECONNREFUSED") {
          reject(
            new WorkbenchError(
              `Cannot connect to Workbench at ${this.host}:${this.port}.`,
              "CONNECTION_REFUSED"
            )
          );
        } else {
          reject(
            new WorkbenchError(
              `Connection error: ${err.message}`,
              "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("data", (chunk) => {
        totalBytes += chunk.length;
        if (totalBytes > MAX_RESPONSE_SIZE) {
          if (!settled) {
            settled = true;
            cleanup();
            socket.destroy();
            reject(
              new WorkbenchError(
                `Response for "${apiFunc}" exceeded ${MAX_RESPONSE_SIZE} bytes — possible malformed data`,
                "PROTOCOL_ERROR"
              )
            );
          }
          return;
        }
        chunks.push(chunk);
      });

      socket.on("end", () => {
        if (settled) return;
        settled = true;
        cleanup();

        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Empty response from Workbench for "${apiFunc}" — connection closed without data`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          logger.debug(`Workbench response for "${apiFunc}":`, result);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.on("close", (hadError) => {
        if (settled) return;
        // close fired without end — connection dropped unexpectedly
        settled = true;
        cleanup();

        if (hadError) {
          reject(
            new WorkbenchError(
              `Connection to Workbench closed with error for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        // No end event + no error = unusual. Try to decode what we have.
        const responseBuf = Buffer.concat(chunks);
        if (responseBuf.length === 0) {
          reject(
            new WorkbenchError(
              `Connection closed without response for "${apiFunc}"`,
              "PROTOCOL_ERROR"
            )
          );
          return;
        }

        try {
          const result = decodeResponse<T>(responseBuf);
          resolve(result);
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const isApiError = errMsg.startsWith("Workbench error:");
          reject(
            new WorkbenchError(
              isApiError ? errMsg : `Failed to decode response for "${apiFunc}": ${errMsg}`,
              isApiError ? "API_ERROR" : "PROTOCOL_ERROR"
            )
          );
        }
      });

      socket.connect(this.port, this.host, () => {
        logger.debug(
          `Connected to Workbench at ${this.host}:${this.port}, calling "${apiFunc}"`
        );
        socket.end(requestBuf);
      });
    });
  }
}

