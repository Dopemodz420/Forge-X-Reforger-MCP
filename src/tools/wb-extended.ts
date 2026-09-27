import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { WorkbenchClient } from "../workbench/client.js";
import { formatConnectionStatus } from "../workbench/status.js";

/** Shape returned by EMCP_WB_ProjectInfo (action: "search"). */
interface SearchResult {
  status?: string;
  message?: string;
  entryCount?: number;
  truncated?: boolean;
  entries?: string[];
}

export function registerWbExtended(server: McpServer, client: WorkbenchClient): void {
  // ── wb_search_resources ───────────────────────────────────────────────────
  server.registerTool(
    "wb_search_resources",
    {
      description:
        "Search the Workbench resource database by path prefix, extension and search string. " +
        "Backed by ResourceDatabase.SearchResources via the EMCP_WB_ProjectInfo handler. " +
        'rootPath uses exact-path format, e.g. "$MyAddon:Prefabs" or "Prefabs/Characters". ' +
        "Results are capped (default 200) — pass `limit` to raise or lower that.",
      inputSchema: {
        rootPath: z
          .string()
          .default("")
          .describe('Exact path root, e.g. "$MyAddon:Prefabs". Empty searches everything the addon set exposes.'),
        extensions: z
          .array(z.string())
          .optional()
          .describe('File extensions without a leading dot, e.g. ["et", "layout"]'),
        searchStr: z
          .array(z.string())
          .optional()
          .describe("Search strings, e.g. ['barrel', 'm1a']"),
        recursive: z.boolean().default(true).describe("Search the whole sub-tree"),
        limit: z.number().min(1).max(2000).default(200).describe("Maximum entries to return"),
      },
    },
    async ({ rootPath, extensions, searchStr, recursive, limit }) => {
      try {
        const res = await client.call<SearchResult>("EMCP_WB_ProjectInfo", {
          action: "search",
          rootPath,
          fileExtensions: extensions ?? [],
          searchStr: searchStr ?? [],
          recursive,
          limit,
        });

        const entries = Array.isArray(res.entries) ? res.entries : [];
        const total = typeof res.entryCount === "number" ? res.entryCount : entries.length;

        if (entries.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: `**No resources matched**${rootPath ? ` under \`${rootPath}\`` : ""}.\n\n${res.message ?? ""}${formatConnectionStatus(client)}`,
              },
            ],
          };
        }

        const lines = [`**${res.message ?? `${total} resources found`}**\n`];
        for (const e of entries) lines.push(`- \`${e}\``);
        if (res.truncated) {
          lines.push(`\n*${total - entries.length} more not shown — raise \`limit\` to see them.*`);
        }
        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Resource search failed: ${msg}${formatConnectionStatus(client)}` }],
          isError: true,
        };
      }
    }
  );

  // ── wb_current_project ────────────────────────────────────────────────────
  server.registerTool(
    "wb_current_project",
    {
      description:
        "Report the game project Workbench currently has open (absolute .gproj path) and the " +
        "Workbench working directory. Backed by Workbench.GetCurrentGameProjectFile() and " +
        "Workbench.GetCwd() via the EMCP_WB_ProjectInfo handler. Use this to confirm which addon " +
        "is active before placing entities or editing resources.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.call<{ projectFile?: string; cwd?: string; message?: string }>(
          "EMCP_WB_ProjectInfo",
          { action: "project" },
          { timeout: 5000 }
        );
        const lines = [
          `**Active Workbench project**`,
          `- **Project file:** \`${res.projectFile || "(none)"}\``,
          `- **Working directory:** \`${res.cwd || "(unknown)"}\``,
        ];
        return { content: [{ type: "text" as const, text: lines.join("\n") + formatConnectionStatus(client) }] };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [{ type: "text" as const, text: `Could not read the active project: ${msg}${formatConnectionStatus(client)}` }],
          isError: true,
        };
      }
    }
  );

  // ── wb_generate_guid ──────────────────────────────────────────────────────
  server.registerTool(
    "wb_generate_guid",
    {
      description:
        "Generate a globally unique 64-bit resource id via Workbench.GenerateGloballyUniqueID64() " +
        "(via the EMCP_WB_ProjectInfo handler). This is the same generator Workbench uses when it " +
        "registers a new resource, so the id is safe to use in a .gproj or a resource reference. " +
        "Fails loudly if Workbench is unavailable — it does not fall back to a random id.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.call<{ guid?: string }>("EMCP_WB_ProjectInfo", { action: "guid" }, { timeout: 5000 });
        const guid = (res.guid || "").trim();
        if (!guid) {
          return {
            content: [{ type: "text" as const, text: `Workbench returned an empty id.${formatConnectionStatus(client)}` }],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: `**Generated id:** \`${guid}\`\n\nUse as \`{${guid}}<path>\` in a resource reference, or as the \`GUID\` field of a .gproj.`,
            },
          ],
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text:
                `Could not generate an id from Workbench: ${msg}\n\n` +
                `Ids must come from Workbench so the resource database accepts them. ` +
                `Start Workbench with \`wb_launch\`, then retry.${formatConnectionStatus(client)}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // ── wb_is_workbench_running ───────────────────────────────────────────────
  server.registerTool(
    "wb_is_workbench_running",
    {
      description:
        "Report whether Workbench and the World Editor are running and whether scripts compiled, " +
        "using the built-in IsWorkbenchRunning / IsWorldEditorRunning functions. Needs no handler " +
        "scripts, so it keeps working even when the bridge is down.",
      inputSchema: {},
    },
    async () => {
      for (const func of ["IsWorkbenchRunning", "IsWorldEditorRunning"]) {
        try {
          const res = await client.call<Record<string, unknown>>(func, {}, { timeout: 3000, skipAutoLaunch: true });
          const running = res.IsRunning === true;
          const compiled = res.ScriptsCompiled;
          const label = func === "IsWorkbenchRunning" ? "Workbench" : "World Editor";
          return {
            content: [
              {
                type: "text" as const,
                text:
                  `**${label}:** ${running ? "running" : "not running"}\n` +
                  `- **Scripts compiled:** ${compiled === true ? "yes" : compiled === false ? "no" : "unknown"}\n` +
                  `- **Raw:** \`${JSON.stringify(res)}\``,
              },
            ],
          };
        } catch {
          // try the next probe
        }
      }
      const alive = await client.ping();
      return {
        content: [
          {
            type: "text" as const,
            text: alive
              ? `Built-in probes unavailable, but the bridge responded to a ping.${formatConnectionStatus(client)}`
              : `Workbench is not answering on the NET API. Check File > Options > General > Net API ` +
                `(enabled, port 5780) and that Workbench is running.`,
          },
        ],
        isError: !alive,
      };
    }
  );
}
