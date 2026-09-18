import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

export function registerWbReload(server: McpServer, client: WorkbenchClient): void {
  server.registerTool(
    "wb_reload",
    {
      description:
        "Reload scripts or plugins in the Workbench. Do NOT reload scripts with World loaded - use safe mode to auto-close world or close manually first. SteamDiag.exe will assert GameApp.cpp:1287 (Resources are leaking!) otherwise. safe=true (default) checks mode, optionally closes world, then reloads; safe=false is direct power-user mode.",
      inputSchema: {
        target: z
          .enum(["scripts", "plugins", "both"])
          .default("scripts")
          .describe("What to reload: scripts, plugins, or both"),
        safe: z
          .boolean()
          .default(true)
          .describe("Safe mode: check World state and auto-close world before reload (default true). Set false for direct reload."),
        closeWorld: z
          .boolean()
          .default(true)
          .describe("When safe=true and a world is open, auto-close it before reload (default true)."),
        force: z
          .boolean()
          .default(false)
          .describe("Force reload even if world is loaded or in play mode (bypasses safe checks)."),
      },
    },
    async ({ target, safe, closeWorld, force }) => {
      const isLeakError = (msg: string): boolean =>
        /Resources are leaking|Leaked instance|still in use|leak|GameApp\.cpp.*1287/i.test(msg);

      const leakHelp = (rawMsg: string): string => {
        const logPath = "%USERPROFILE%\\Documents\\My Games\\Arma Reforger\\logs\\ArmaReforgerWorkbench_*.log";
        const altLog = "%USERPROFILE%\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_*\\error.log";
        return (
          `**Reload Failed — Resources Are Leaking (GameApp.cpp:1287)**\n\n` +
          `Workbench detected leaked Widgets/Resources/Entities parented to the world after VM destroy. ` +
          `This happens when you reload scripts while a World is loaded in the World Editor.\n\n` +
          `**Action:** In the assert dialog choose **Abort** (or close Workbench), then **Restart Workbench**. ` +
          `Do NOT choose Ignore — the VM is in a leaked state.\n\n` +
          `**Logs:**\n` +
          `- Game log: \`${logPath}\`\n` +
          `- Workbench logs: \`${altLog}\`\n` +
          `- Also run \`wb_diagnose_leak\` to grep leaked resource names (UI/layouts/*.edds, SCR_*).\n\n` +
          `**Prevention:** Never use \`wb_reload\` / \`Game > Reload Scripts\` with a world open. ` +
          `Use \`safe:true, closeWorld:true\` (default) to auto-close the world first, or manually close the world (` +
          `File > Close) and ensure \`wb_state\` shows \`mode: no_world_editor\` or \`edit\` with 0 entities before reloading.\n\n` +
          `Raw error: ${rawMsg}${formatConnectionStatus(client)}`
        );
      };

      // ---- safe=false: direct power-user path ----
      if (!safe) {
        try {
          const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });
          return {
            content: [
              {
                type: "text" as const,
                text: `**Reload Complete**\n\n${result.message || "Reload triggered."}${formatConnectionStatus(client)}`,
              },
            ],
          };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (isLeakError(msg)) {
            return { content: [{ type: "text" as const, text: leakHelp(msg) }], isError: true };
          }
          return {
            content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
            isError: true,
          };
        }
      }

      // ---- safe=true path ----
      // a) Check current state (mode + world loaded)
      let state: Record<string, unknown> | null = null;
      try {
        state = await client.call<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 8000 });
      } catch {
        // If GetState fails, try refreshState fallback; still allow reload attempt but warn
        try {
          await client.refreshState();
          state = { mode: (client.state as unknown as Record<string, unknown>).mode as string } as Record<string, unknown>;
        } catch {
          state = null;
        }
      }

      const mode = (state?.mode as string | undefined) || (client.state.mode as string) || "unknown";
      const entityCount = state?.entityCount as number | undefined;
      const selectedCount = state?.selectedCount as number | undefined;
      const currentSubScene = state?.currentSubScene as number | undefined;
      const boundsMin = state?.boundsMin as string | undefined;

      const isPlayMode = mode === "play" || mode === "game";
      // Conservative world-open detection: edit mode with any world data
      const worldOpen =
        mode === "edit" &&
        (entityCount !== undefined ||
          selectedCount !== undefined ||
          currentSubScene !== undefined ||
          !!boundsMin ||
          (entityCount !== undefined && entityCount > 0));

      // If we cannot determine world state precisely, treat edit as potentially open when entityCount is present
      const maybeWorldOpen = worldOpen || mode === "edit";

      // a) Handle play mode
      if (isPlayMode) {
        if (force) {
          // fall through to reload despite play mode
        } else if (closeWorld) {
          // Try to stop play mode first
          try {
            await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", { action: "stop" }, { timeout: 8000 });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot reload: Workbench is in **play/game mode** and auto-stop failed: ${msg}\n\nCall \`wb_stop\` first, or use \`force:true\` to bypass.${formatConnectionStatus(client)}`,
                },
              ],
              isError: true,
            };
          }
          // Poll until edit/no_world_editor
          const deadline = Date.now() + 12000;
          let stopped = false;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 600));
            if (!(await client.ping())) continue;
            try {
              const s = await client.call<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 4000 });
              const m = s.mode as string;
              if (m === "edit" || m === "no_world_editor") {
                stopped = true;
                state = s;
                break;
              }
            } catch {
              // ignore
            }
          }
          if (!stopped) {
            return {
              content: [
                {
                  type: "text" as const,
                  text: `Cannot reload: Workbench did not return to edit mode after auto-stop. Try \`wb_stop\` manually, then reload.${formatConnectionStatus(client)}`,
                },
              ],
              isError: true,
            };
          }
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text: `Cannot reload: Workbench is in **play/game mode** (mode=${mode}). Call \`wb_stop\` first, or use \`closeWorld:true\` to auto-stop, or \`force:true\` to bypass.${formatConnectionStatus(client)}`,
              },
            ],
            isError: true,
          };
        }
      }

      // b) Handle world open in edit mode
      const effectiveWorldOpen = maybeWorldOpen || worldOpen;
      if (effectiveWorldOpen && !force) {
        if (closeWorld) {
          // Attempt to close world
          let closeOk = false;
          let closeErr: string | undefined;
          // Primary: EditorControl close
          try {
            await client.call<Record<string, unknown>>("EMCP_WB_EditorControl", { action: "close" }, { timeout: 8000 });
            closeOk = true;
          } catch (e) {
            closeErr = e instanceof Error ? e.message : String(e);
            // Fallback: try dedicated CloseWorld handler if present
            try {
              await client.call<Record<string, unknown>>("EMCP_WB_CloseWorld", {}, { timeout: 5000 });
              closeOk = true;
              closeErr = undefined;
            } catch {
              // keep original error
            }
          }

          if (!closeOk) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    `Safe reload aborted: world appears open (mode=${mode}, entityCount=${entityCount ?? "?"}) and auto-close failed: ${closeErr || "unknown error"}\n\n` +
                    `Close the world manually (File > Close) until \`wb_state\` shows \`no_world_editor\` or 0 entities, then retry. ` +
                    `Or use \`closeWorld:false, force:true\` to bypass (will likely assert GameApp.cpp:1287).${formatConnectionStatus(client)}`,
                },
              ],
              isError: true,
            };
          }

          // Wait poll + ping until edit/no-world state
          const deadline = Date.now() + 12000;
          let closed = false;
          while (Date.now() < deadline) {
            await new Promise((r) => setTimeout(r, 700));
            if (!(await client.ping())) continue;
            try {
              const s = await client.call<Record<string, unknown>>("EMCP_WB_GetState", {}, { timeout: 4000 });
              const m = s.mode as string;
              const ec = s.entityCount as number | undefined;
              // Consider closed if no_world_editor, or edit with 0/undefined entities
              if (m === "no_world_editor" || (m === "edit" && (ec === undefined || ec === 0))) {
                closed = true;
                break;
              }
              // If still edit with entities, keep polling a bit
              if (m === "edit") {
                // If we see edit with entities still, continue polling but allow success after timeout? Require closed.
                continue;
              }
            } catch {
              // transient
            }
          }
          // Even if not fully confirmed closed, we proceed — Workbench may have closed but GetState still reports stale count briefly.
          // The leak assert will be caught in the reload step if still leaking.
          if (!closed) {
            // Soft warning but proceed — reload will either succeed or trigger leak handler
            // We do not hard-fail here; attempt reload and let leakHelp handle the assert case.
          }
        } else {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `Safe reload aborted: world appears open (mode=${mode}, entityCount=${entityCount ?? "?"}). ` +
                  `This will assert **GameApp.cpp:1287 Resources are leaking!**\n\n` +
                  `Options:\n` +
                  `- Keep \`safe:true, closeWorld:true\` (default) to auto-close\n` +
                  `- Or manually close world (File > Close) until \`wb_state\` shows no world\n` +
                  `- Or pass \`force:true\` to reload anyway (expect assert on SteamDiag)${formatConnectionStatus(client)}`,
              },
            ],
            isError: true,
          };
        }
      }

      // c) Only then reload
      try {
        const result = await client.call<Record<string, unknown>>("EMCP_WB_Reload", { target });
        return {
          content: [
            {
              type: "text" as const,
              text: `**Reload Complete (safe)**\n\n${result.message || "Reload triggered."}${formatConnectionStatus(client)}`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (isLeakError(msg)) {
          return { content: [{ type: "text" as const, text: leakHelp(msg) }], isError: true };
        }
        return {
          content: [{ type: "text" as const, text: `Error reloading: ${msg}${formatConnectionStatus(client)}` }],
          isError: true,
        };
      }
    }
  );
}
