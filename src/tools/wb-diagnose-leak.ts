import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { Config } from "../config.js";

export function registerWbDiagnoseLeak(server: McpServer, config: Config): void {
  server.registerTool(
    "wb_diagnose_leak",
    {
      description:
        "Diagnose the classic Workbench leak assert (GameApp.cpp:1287 Resources are leaking!). " +
        "Finds the latest Workbench log, greps for 'Resources are leaking' / 'Leaked instance' / 'still in use', " +
        "and returns the last 50 matching lines plus leaked resource names (UI/layouts/*.edds, SCR_*). " +
        "Use after a failed wb_reload or when SteamDiag.exe shows the leak assert.",
      inputSchema: {
        logPath: z
          .string()
          .optional()
          .describe("Optional explicit path to a Workbench log file or directory to scan. If omitted, auto-discovers latest log."),
        maxLines: z
          .number()
          .min(1)
          .max(200)
          .default(50)
          .describe("Maximum matching lines to return (default 50)"),
      },
    },
    async ({ logPath, maxLines }) => {
      const patterns = [/Resources are leaking/i, /Leaked instance/i, /still in use/i];
      // Extra patterns to catch related leak noise
      const extraPatterns = [/Resource leaks/i, /GameApp\.cpp.*1287/i];
      const allPatterns = [...patterns, ...extraPatterns];

      const leakResourceRegex = /(UI\/layouts\/[^\s"']+|\S+\.edds|SCR_[A-Za-z0-9_]+)/g;

      const candidateBases: string[] = [];
      if (logPath) candidateBases.push(resolve(logPath));

      // Workbench log locations (Documents/My Games)
      const home = homedir();
      candidateBases.push(join(home, "Documents", "My Games", "ArmaReforgerWorkbench", "logs"));
      candidateBases.push(join(home, "Documents", "My Games", "Arma Reforger", "logs"));
      candidateBases.push(join(home, "Documents", "My Games", "ArmaReforgerWorkbench", "profile"));
      // Also check config-derived fallback (workbenchPath parent may hint at install, not logs, but keep for compat)
      if (config?.workbenchPath) {
        // Not a log location, but keep as last resort for diagnosis
        candidateBases.push(join(config.workbenchPath, "logs"));
      }

      // Helper: recursively find .log files up to depth 3
      function findLogFiles(base: string, depth = 0, maxDepth = 3): string[] {
        const out: string[] = [];
        if (depth > maxDepth) return out;
        let entries: ReturnType<typeof readdirSync>;
        try {
          entries = readdirSync(base, { withFileTypes: true }) as unknown as ReturnType<typeof readdirSync>;
        } catch {
          return out;
        }
        for (const e of entries as unknown as Array<{ name: string; isDirectory(): boolean; isFile(): boolean }>) {
          const full = join(base, e.name);
          if (e.isFile() && e.name.toLowerCase().endsWith(".log")) {
            out.push(full);
          } else if (e.isDirectory()) {
            out.push(...findLogFiles(full, depth + 1, maxDepth));
          }
        }
        return out;
      }

      let logFiles: string[] = [];
      let usedBase: string | undefined;

      // If explicit logPath is a file, use it directly
      if (logPath && existsSync(resolve(logPath))) {
        try {
          const st = statSync(resolve(logPath));
          if (st.isFile()) {
            logFiles = [resolve(logPath)];
            usedBase = resolve(logPath);
          } else if (st.isDirectory()) {
            logFiles = findLogFiles(resolve(logPath));
            usedBase = resolve(logPath);
          }
        } catch {
          // ignore
        }
      }

      // Auto-discover if no explicit file
      if (logFiles.length === 0) {
        for (const base of candidateBases) {
          if (!existsSync(base)) continue;
          const found = findLogFiles(base);
          if (found.length > 0) {
            // Prefer the most recently modified
            found.sort((a, b) => {
              try {
                const sa = statSync(a).mtimeMs;
                const sb = statSync(b).mtimeMs;
                return sb - sa;
              } catch {
                return 0;
              }
            });
            logFiles = found;
            usedBase = base;
            break;
          }
        }
      }

      // If still none, also try glob-like search for ArmaReforgerWorkbench_*.log in game logs dir
      if (logFiles.length === 0) {
        for (const base of candidateBases) {
          if (!existsSync(base)) continue;
          try {
            const entries = readdirSync(base, { withFileTypes: true }) as unknown as Array<{ name: string; isFile(): boolean; isDirectory(): boolean }>;
            for (const e of entries) {
              if (e.isFile() && /ArmaReforgerWorkbench.*\.log$/i.test(e.name)) {
                logFiles.push(join(base, e.name));
              }
            }
            if (logFiles.length > 0) {
              usedBase = base;
              break;
            }
          } catch {
            // ignore
          }
        }
      }

      if (logFiles.length === 0) {
        const expected = [
          "%USERPROFILE%\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_*\\error.log",
          "%USERPROFILE%\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_*\\console.log",
          "%USERPROFILE%\\Documents\\My Games\\Arma Reforger\\logs\\ArmaReforgerWorkbench_*.log",
          join(home, "Documents", "My Games", "ArmaReforgerWorkbench", "logs"),
          join(home, "Documents", "My Games", "Arma Reforger", "logs"),
        ].join("\n  - ");
        return {
          content: [
            {
              type: "text" as const,
              text:
                `**No Workbench log found**\n\n` +
                `Searched:\n  - ${candidateBases.join("\n  - ")}\n\n` +
                `Expected locations:\n  - ${expected}\n\n` +
                `If Workbench recently asserted **GameApp.cpp:1287 Resources are leaking!**, click **Abort** and restart Workbench. ` +
                `Logs are written on close — check the latest \`logs_*\\error.log\` and console.log. ` +
                `Alternatively pass \`logPath\` explicitly to this tool.\n\n` +
                `Prevention: never call \`wb_reload\` / \`Game > Reload Scripts\` with a world open. ` +
                `Use \`wb_reload safe:true, closeWorld:true\` (default) or close the world first (File > Close) until \`wb_state\` shows no world.`,
            },
          ],
        };
      }

      // Pick the most recent log file
      let latestLog = logFiles[0];
      let latestMtime = 0;
      try {
        latestMtime = statSync(latestLog).mtimeMs;
        for (const f of logFiles) {
          try {
            const m = statSync(f).mtimeMs;
            if (m > latestMtime) {
              latestMtime = m;
              latestLog = f;
            }
          } catch {
            // ignore
          }
        }
      } catch {
        // keep first
      }

      // Read and grep
      let content: string;
      try {
        content = readFileSync(latestLog, "utf-8");
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          content: [
            {
              type: "text" as const,
              text: `Failed to read log \`${latestLog}\`: ${msg}\n\nTry passing a different \`logPath\`.`,
            },
          ],
          isError: true,
        };
      }

      const lines = content.split(/\r?\n/);
      const matched: string[] = [];
      const leakedResources = new Set<string>();

      for (const line of lines) {
        if (allPatterns.some((re) => re.test(line))) {
          matched.push(line);
          // Extract resource names
          let m: RegExpExecArray | null;
          // Reset regex lastIndex
          leakResourceRegex.lastIndex = 0;
          while ((m = leakResourceRegex.exec(line)) !== null) {
            // Filter to interesting: UI/layouts/*, *.edds, SCR_*
            const token = m[0];
            if (token.includes("UI/layouts") || token.endsWith(".edds") || token.startsWith("SCR_")) {
              leakedResources.add(token);
            } else if (token.startsWith("SCR_")) {
              leakedResources.add(token);
            }
            // Avoid infinite loop on zero-length
            if (m[0].length === 0) leakResourceRegex.lastIndex++;
          }
        }
      }

      const totalMatches = matched.length;
      const tail = matched.slice(-maxLines);
      const resourceList = Array.from(leakedResources).slice(0, 100);

      const header: string[] = [];
      header.push(`**Workbench Leak Diagnosis**\n`);
      header.push(`- **Log:** \`${latestLog}\` (${new Date(latestMtime).toLocaleString()})`);
      header.push(`- **Scanned:** ${lines.length} lines, ${totalMatches} matching leak lines`);
      header.push(`- **Showing:** last ${tail.length} matches (maxLines=${maxLines})`);
      header.push(`- **Searched bases:** \`${usedBase}\` (${logFiles.length} log files found)`);
      header.push("");

      if (totalMatches === 0) {
        header.push(`No leak markers (\`Resources are leaking\` / \`Leaked instance\` / \`still in use\`) found in the latest log.\n`);
        header.push(`This is good — no GameApp.cpp:1287 leak detected in this log.\n`);
        header.push(`If you just saw the assert, the log may be the *previous* run's \`logs_*\` folder. Try passing \`logPath\` to the specific \`.log\` shown in the assert dialog, or check:\n`);
        header.push(`  - \`%USERPROFILE%\\Documents\\My Games\\ArmaReforgerWorkbench\\logs\\logs_*\\error.log\`\n`);
        header.push(`  - \`%USERPROFILE%\\Documents\\My Games\\Arma Reforger\\logs\\ArmaReforgerWorkbench_*.log\`\n`);
        // Still show tail of log for context
        const tailContext = lines.slice(-20).join("\n");
        if (tailContext.trim()) {
          header.push(`\n**Last 20 lines of log for context:**\n\`\`\`\n${tailContext}\n\`\`\``);
        }
        return { content: [{ type: "text" as const, text: header.join("\n") }] };
      }

      header.push(`**Matching lines (last ${tail.length}):**\n\`\`\`\n${tail.join("\n")}\n\`\`\``);

      if (resourceList.length > 0) {
        header.push(`\n**Leaked resource names (filtered to UI/layouts/*.edds/SCR_* — ${resourceList.length} unique):**\n`);
        header.push(resourceList.map((r) => `- \`${r}\``).join("\n"));
      } else {
        header.push(`\n**Leaked resource names:** none extracted with UI/layouts/*.edds/SCR_* filter. `);
        header.push(`The matched lines above still contain the raw leak details (look for \`still in use\` entries).\n`);
      }

      header.push(
        `\n**Next steps:**\n` +
          `- In the assert dialog click **Abort** (not Ignore), restart Workbench.\n` +
          `- Never reload with a world open: use \`wb_reload safe:true, closeWorld:true\` or close world first (File > Close) until \`wb_state\` shows \`no_world_editor\` or 0 entities.\n` +
          `- Run \`wb_state\` to confirm mode, then retry reload.\n` +
          `- Full log: \`${latestLog}\` — open it for the complete \`Resources are leaking! Check log!\` block.\n`
      );

      return { content: [{ type: "text" as const, text: header.join("\n") }] };
    }
  );
}
