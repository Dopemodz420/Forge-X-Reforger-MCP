# Forge-X Reforger MCP

**The universal AI modding toolkit for Arma Reforger — Forge-X Edition.**

Describe what you want to build — your AI agent handles API research, code generation, project scaffolding, Workbench control, and in-editor testing. Works with **any MCP-compatible agent**: Cursor, Google Antigravity, Claude Desktop, Claude Code, Kiro, Windsurf, VS Code Copilot, Continue.dev, and OpenCode.

> Forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK) and [wastelandgoats/reforger-forge-mcp](https://github.com/wastelandgoats/reforger-forge-mcp) with permission. Forge-X adds 34 new tools, Workbench lifecycle hardening (`EMCP_WB_Ping`/`GetState` bootstrap, `wb_reload safe`, `finishCall`), `wb_diagnose_leak`, export-VFS boost, script/index/world/logs depth, and ongoing maintenance as an independent project.

## Features

- **87 MCP tools** — API search, wiki, asset browsing, code generation, Workbench live control (53 → 87, +34: layout_validate, string_table, project_search/diff/references/stats/batch/export/template/migrate, prefab_diff, mod_compat, config_validate, project_scaffold_ui, resolve_guid, script_analyze/lint, wb_validate_scripts, wb_diagnose_leak, project_index_status, inheritance_chain, find_broken_refs, find_unused_resources, script_overrides, script_find_rpc, script_class_hierarchy, wb_search_resources, wb_current_project, wb_generate_guid, wb_is_workbench_running, logs_list, logs_tail, world_compose_summary, world_validate_refs)
- **8,693 indexed API classes** — full Enfusion/Arma Reforger class hierarchy
- **250+ wiki guides** — searchable tutorials and documentation
- **Agent-agnostic** — one server, install script for every major AI IDE
- **Zero modding experience required** — natural language → built addon
- **222k+ game files indexed** — full pak archive browsing, search, and reading
- **Optional export boost** — 100x faster reads with unpacked game data

## Quick Start

```bash
git clone https://github.com/Dopemodz420/Forge-X-Reforger-MCP.git
cd Forge-X-Reforger-MCP
npm install
npm run build
```

Or on Windows:

```powershell
.\scripts\setup.ps1
```

Then install into your agent(s):

```powershell
# Install into ALL supported agents at once
.\scripts\install-agents.ps1 -All

# Or pick one
.\scripts\install-agents.ps1 -Agent antigravity
.\scripts\install-agents.ps1 -Agent cursor
```

Restart your agent and verify **forge-x-reforger-mcp** (or `forge-x`) shows **87 tools**.

### Configure paths

Copy and edit the config file:

```bash
cp reforger-forge.config.example.json reforger-forge.config.json
```

| Key | Description |
|-----|-------------|
| `workbenchPath` | Arma Reforger Tools (Steam) install |
| `gamePath` | Arma Reforger game install |
| `projectPath` | Where your mods are saved |

Re-run `.\scripts\install-agents.ps1` after changing paths so all agents get updated env vars.

---

## Agent Setup

ReforgerForge uses **stdio MCP** (local Node.js process). Every agent below runs the same server — only the config file location differs.

| Agent | Config file | Install command |
|-------|-------------|-----------------|
| **Cursor** | `%USERPROFILE%\.cursor\mcp.json` | `.\scripts\install-agents.ps1 -Agent cursor` |
| **Google Antigravity** | `%USERPROFILE%\.gemini\config\mcp_config.json` | `.\scripts\install-agents.ps1 -Agent antigravity` |
| **Claude Desktop** | `%APPDATA%\Claude\claude_desktop_config.json` | `.\scripts\install-agents.ps1 -Agent claude` |
| **Windsurf** | `%USERPROFILE%\.codeium\windsurf\mcp_config.json` | `.\scripts\install-agents.ps1 -Agent windsurf` |
| **VS Code (Copilot)** | `%APPDATA%\Code\User\mcp.json` + `.vscode\mcp.json` | `.\scripts\install-agents.ps1 -Agent vscode` |
| **Continue.dev** | `%USERPROFILE%\.continue\config.json` | `.\scripts\install-agents.ps1 -Agent continue` |
| **Kiro** | `.kiro/settings/mcp.json` (workspace) | `.\scripts\install-agents.ps1 -Agent kiro` |
| **All agents** | All of the above | `.\scripts\install-agents.ps1 -All` |

### Google Antigravity

1. Run `.\scripts\install-agents.ps1 -Agent antigravity`
2. Open Antigravity → **Settings** → **Customizations** → **Open MCP Config**
3. Confirm `reforger-forge` appears, then click **Refresh** in Installed MCP Servers
4. The shared config is at `~/.gemini/config/mcp_config.json` (same file used by Antigravity CLI)

Manual config (if needed):

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": ["C:\\full\\path\\to\\reforger-forge-mcp\\dist\\index.js"],
      "env": {
        "ENFUSION_WORKBENCH_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger Tools",
        "ENFUSION_GAME_PATH": "C:\\Program Files (x86)\\Steam\\steamapps\\common\\Arma Reforger",
        "ENFUSION_PROJECT_PATH": "C:\\Users\\YOU\\Documents\\My Games\\ArmaReforgerWorkbench\\addons"
      }
    }
  }
}
```

### Cursor

Workspace config: `.cursor/mcp.json` (included). Global: run install script or merge `configs/cursor-global.json`.

Restart → **MCP: Restart Servers**

### Claude Desktop

Merge `configs/claude-desktop.json` or run install script.

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

### Claude Code

```bash
# Windows
claude mcp add --scope user reforger-forge -- cmd /c node "FULL_PATH\reforger-forge-mcp\dist\index.js"

# macOS / Linux
claude mcp add --scope user reforger-forge -- node /path/to/reforger-forge-mcp/dist/index.js
```

### VS Code (GitHub Copilot)

Uses `servers` key (not `mcpServers`). Run install script — it writes both user-level and workspace `.vscode/mcp.json`.

Command palette: **MCP: List Servers** → verify `reforger-forge` is running.

### Windsurf (Cascade)

Global config only at `~/.codeium/windsurf/mcp_config.json`. Run install script, then refresh MCP list in Cascade panel.

### Continue.dev

Run install script. MCP servers live inside `~/.continue/config.json` under `mcpServers`.

### Any other MCP client

Use the stdio template at `configs/agents/stdio-template.json`. Replace `REPLACE_WITH_ABSOLUTE_PATH` with your clone path.

```json
{
  "mcpServers": {
    "reforger-forge": {
      "command": "node",
      "args": ["/absolute/path/to/reforger-forge-mcp/dist/index.js"],
      "env": {
        "ENFUSION_WORKBENCH_PATH": "...",
        "ENFUSION_GAME_PATH": "...",
        "ENFUSION_PROJECT_PATH": "..."
      }
    }
  }
}
```

---

## Complete Tool Reference (87 tools)

Legend: **Offline** = no Workbench needed | **Live** = requires Workbench running (`wb_launch`)

### API & Documentation (Offline)

| Tool | What it does |
|------|-------------|
| `api_search` | Search 8,693 Enfusion/Arma Reforger API classes and methods. Includes inherited methods, enum detection, sibling classes, and `format: 'tree'` for ASCII inheritance hierarchy. |
| `component_search` | Find ScriptComponent descendants — filter by category (character, vehicle, weapon, damage, inventory, ai, ui, etc.) and event handlers (e.g. `OnDamage`, `EOnFrame`). |
| `wiki_search` | Search 250+ pre-downloaded BIKI wiki pages and Enfusion tutorials. Returns previews — use `wiki_read` for full content. |
| `wiki_read` | Read the full content of a wiki page by title, including code examples (up to 100k chars, no truncation). |
| `wb_knowledge` | Search the bundled modding knowledge base — scripting, audio, weapons, vehicles, AI, UI, game modes, animation, and more. Use `query='index'` to list all topics. |

### Game Assets (Offline)

| Tool | What it does |
|------|-------------|
| `game_browse` | Browse base game files (scripts, prefabs, configs) from loose files, `.pak` archives, and export directory. |
| `game_read` | Read a specific base game file — vanilla `.c` scripts, `.et` prefabs, `.conf` configs, `.layout` UI files, `.imageset` atlases. Shows fuzzy "Did you mean?" suggestions on miss. |
| `game_search` | Search game files by name pattern, class name, GUID, or content reference. Four modes: filename, class, guid, reference. |
| `game_class_info` | Look up class hierarchy — parent chain, subclasses, file location. Scans all scripts across paks and export. |
| `game_stats` | Diagnostic overview — file counts by type, pak files loaded, VFS index size, export directory status. |
| `asset_search` | Search game assets (prefabs, models, textures, scripts, configs) by name across loose files and `.pak` archives. Returns paths and GUIDs. |
| `resolve_guid` | Resolve a 16-hex GUID → defining file, class, and references (project + base game). |
| `game_duplicate` | Duplicate a base game prefab/config into your mod folder with full ancestor chain resolved. Optionally `flatten=true` to bake all inherited components. Registers with Workbench for a new GUID. |
| `workshop_info` | Read Workshop metadata from a mod's `.gproj` — mod ID, GUID, title, dependencies, configurations. |

### Project & Mod Management

| Tool | Workbench? | What it does |
|------|-----------|-------------|
| `project` | No | Browse, read, or write files in your mod project directory (`action`: browse / read / write). |
| `mod` | Build only | Manage addons: `action=create` scaffold new addon, `action=validate` check structure, `action=build` compile with Workbench CLI. |
| `workshop_info` | No | Read `.gproj` Workshop publish metadata. |

### Code Generation (Offline)

| Tool | What it does |
|------|-------------|
| `script_create` | Generate Enforce Script `.c` files — component, gamemode, action, entity, manager, modded, basic. Auto-fetches overridable parent methods from API index. |
| `script_analyze` | Parse a `.c` file → AST: classes, modded chains, methods, attributes, includes, `[RPC]`. |
| `script_lint` | Lint a `.c` file for BI conventions (naming, tabs, line length). |
| `prefab` | `action=create`: Generate `.et` prefab with components and ancestry. `action=inspect`: Full inheritance chain merge showing which ancestor each component/value comes from. |
| `layout_create` | Generate UI `.layout` files — hud, menu, dialog, list, custom widget types. |
| `config_create` | Generate `.conf` files — factions, mission headers, entity catalogs, editor placeables. |
| `server_config` | Generate `server.json` for local dedicated server testing. |

### Scenarios & Advanced Workflows

| Tool | Workbench? | What it does |
|------|-----------|-------------|
| `scenario_create` | **Live** | Place scenario elements in open Workbench world — `type=objective` (SP/co-op Scenario Framework hierarchy) or `type=base` (Conflict multiplayer base). |
| `scenario_create_conflict` | No | Generate a complete Conflict multiplayer scenario (up to 7 files): mission header, SubScene stub, layer files with game mode, bases, capture zones, defenders, ambient vehicles. |
| `animation_graph` | No | Vehicle animation graph tool — `action=author` (generate .agr/.ast scaffolds), `action=inspect` (read/validate graphs), `action=setup` (full guided wizard). |
| `building_setup` | No | Set up destructible building from Blender export manifest — creates structure prefab with slot wiring and per-phase destruction components. |

### Workbench Connection & Diagnostics (Live)

| Tool | What it does |
|------|-------------|
| `wb_launch` | Start Arma Reforger Workbench, install handler scripts into mod, wait for NET API. Auto-called by other `wb_*` tools when needed. Call `wb_cleanup` before publishing mod. |
| `wb_connect` | Test connection to Workbench NET API. Returns connection status and editor mode. |
| `wb_diagnose` | Full diagnostic — config, handler script locations, NET API status. Use when `wb_launch` or `wb_connect` fails. |
| `wb_diagnose_leak` | Grep Workbench logs for `Resources are leaking` / `GameApp.cpp:1287` and summarize leaked `UI/layouts`/`*.edds`/`SCR_*`. |
| `wb_cleanup` | Remove temporary EnfusionMCP handler scripts from mod before publishing. Safe even if never installed. |
| `wb_state` | Full Workbench snapshot — mode (edit/play), entity count, selection, terrain bounds, sub-scene, prefab edit status. |
| `wb_reload` | Reload scripts/plugins with `safe:true` auto-close world to avoid `GameApp.cpp:1287` leak; `wb_validate_scripts` validates without handler. |
| `wb_validate_scripts` | Validate scripts via builtin `ValidateScripts` (no custom handler, no restart). |

### Workbench Editor Control (Live)

| Tool | What it does |
|------|-------------|
| `wb_play` | Enter play mode (Play in Editor). Compiles scripts and launches world for testing. |
| `wb_stop` | Exit play mode, return to World Editor. |
| `wb_save` | Save current world. Optionally Save As to new path. Edit mode only. |
| `wb_undo_redo` | Undo or redo the last World Editor action. |
| `wb_open_resource` | Open a resource in its editor (.et → Prefab Editor, .c → Script Editor, etc.). |
| `wb_execute_action` | Run any Workbench menu action by path (e.g. `Tools,Reload Scripts`). Destructive actions blocked. |

### Workbench Entities (Live)

| Tool | What it does |
|------|-------------|
| `wb_entity_create` | Create entity from prefab at position/rotation. Optional name and target layer. Edit mode only. |
| `wb_entity_delete` | Delete entity by name. Edit mode only. |
| `wb_entity_list` | List entities in current world with pagination and optional name filter. |
| `wb_entity_inspect` | Get entity details — components, properties, position, children. By name or index. |
| `wb_entity_modify` | Move, rotate, rename, reparent, set/clear/list component properties, manage array items. Edit mode only. |
| `wb_entity_select` | Select, deselect, clear, or get current selection. |
| `wb_entity_duplicate` | Duplicate a scene entity (including locked base-game instances) into your mod as a standalone `.et` with new GUID. |
| `wb_component` | Add, remove, or list components on an entity. Edit mode only for add/remove. |
| `wb_clipboard` | Copy, cut, paste, paste at cursor, duplicate selected entities, check clipboard content. |

### Workbench World & Resources (Live)

| Tool | What it does |
|------|-------------|
| `wb_terrain` | Query terrain height at coordinates or get world bounds (min/max extents). |
| `wb_layers` | Create, delete, rename layers; set active layer; toggle visibility/lock. Edit mode only for mutations. |
| `wb_resources` | Register new resources, rebuild resource databases, get resource info, open in editor. |
| `wb_prefabs` | Create entity templates, save prefab changes, GUID lookup, locate prefabs by path. Edit mode only for create/save. |
| `wb_projects` | List loaded addon projects, locate project by name, open `.gproj` file in Workbench. |
| `wb_localization` | Insert, delete, modify string table entries, or get full localization table. |
| `wb_script_editor` | Read/write lines in the open Script Editor file — get file, read/write/insert/remove lines, line count. |
| `wb_validate` | Validate material or texture resources using Workbench built-in validators. Returns errors and warnings. |

Run `node scripts/list-tools.mjs` anytime to verify all 87 tools register on your machine.

---

## Usage Examples

```
Create a HUD widget that shows player health and stamina
Make a zombie survival game mode with wave spawning
Search the API for all vehicle damage components
Launch Workbench, load my mod, and enter play mode
Generate a Conflict scenario for Everon with 3 bases
Inspect the inheritance chain for Rifle_M16A2.et
```

---

## Configuration

Environment variables override config files:

| Variable | Description | Default |
|----------|-------------|---------|
| `ENFUSION_WORKBENCH_PATH` | Arma Reforger Tools path | Steam default |
| `ENFUSION_GAME_PATH` | Arma Reforger game path | Sibling of Tools |
| `ENFUSION_PROJECT_PATH` | Mod output directory | `~/Documents/My Games/.../addons` |
| `ENFUSION_EXPORT_PATH` | Unpacked game data export (optional, faster reads) | none |
| `ENFUSION_WORKBENCH_HOST` | NET API host | `127.0.0.1` |
| `ENFUSION_WORKBENCH_PORT` | NET API port | `5780` (verified — legacy `5775` if your Workbench still uses it) |
| `REFORGER_FORGE_DEBUG` | Enable debug logging | off |

Config file search order:
1. `reforger-forge.config.json` (project root)
2. `~/.reforger-forge/config.json` (user home)
3. Legacy `enfusion-mcp.config.json` paths (backward compatible)

---

## Requirements

- **Node.js 20+**
- **Arma Reforger** (Steam) — for game asset browsing (222k+ files indexed from `.pak`)
- **Arma Reforger Tools** (Steam) — for `mod` build and all `wb_*` tools (optional for read-only use)

### Optional: Export Directory

For faster file reads, you can use an unpacked game data export from [ReforgerPakTool](https://github.com/user/ReforgerPakTool). This indexes 106k+ files as plain text on disk (1ms reads vs ~100ms from pak decompression).

```bash
# Set in config or environment
ENFUSION_EXPORT_PATH=D:\path\to\Enfusion-Export-MCPINFO
```

Without the export, everything works perfectly — the tool falls back to reading from `.pak` archives automatically.

---

## Sharing & Distribution

### For Friends (Quick Setup)

1. **Clone or zip** the `reforger-forge-mcp` folder
2. Send it to your friend (or push to GitHub)
3. Friend runs:

```powershell
cd reforger-forge-mcp
.\scripts\setup.ps1
```

The setup script will:
- Auto-detect Arma Reforger install paths (Steam, Epic)
- Create config with correct paths
- Install dependencies and build
- Optionally install into their AI agent

### For GitHub Distribution

```bash
git remote add origin https://github.com/Dopemodz420/Forge-X-Reforger-MCP.git
git push -u origin main
```

Friends can then:

```bash
git clone https://github.com/Dopemodz420/Forge-X-Reforger-MCP.git
cd Forge-X-Reforger-MCP
.\scripts\setup.ps1    # Windows
# or
npm install && npm run build && node scripts/list-tools.mjs
```

### What's Included

- All source code, build scripts, and agent configs
- 8,693 indexed API classes (in `data/`)
- 250+ wiki pages (in `data/`)
- Workbench handler scripts (in `mod/`)
- Agent install scripts for 7+ AI IDEs

### What's NOT Included (User Must Have)

- Arma Reforger game installation (provides `.pak` archives)
- Arma Reforger Tools (optional, for Workbench control)
- Export directory (optional, for faster reads)

---

## Development

```bash
npm run build                  # Compile TypeScript
npm test                       # Run test suite (453 passed, 12 skipped)
npm run dev                    # Run server in dev mode
node scripts/list-tools.mjs    # Verify all 87 tools register
.\scripts\install-agents.ps1 -All   # Push config to all agents
```

## Project Structure

```
reforger-forge-mcp/
├── src/                         # TypeScript source
├── data/                        # API index, wiki, patterns, knowledge base
├── mod/                         # Workbench NET API handler scripts
├── configs/agents/              # Manual install templates
├── scripts/
│   ├── setup.ps1                # Build + configure
│   ├── install-agents.ps1       # Install into any AI agent
│   └── list-tools.mjs           # Verify tool registration
├── .cursor/mcp.json             # Cursor workspace
├── .vscode/mcp.json             # VS Code workspace
├── .kiro/settings/mcp.json      # Kiro workspace
└── dist/                        # Built server (generated)
```

## Publishing to GitHub

```bash
git remote add origin https://github.com/Dopemodz420/Forge-X-Reforger-MCP.git
git push -u origin main
```

## Credits & Attribution

**Forge-X Reforger MCP** is based on:

- **[steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK)** — primary upstream fork
- **[wastelandgoats/reforger-forge-mcp](https://github.com/wastelandgoats/reforger-forge-mcp)** — prior fork
- **[Articulated7/enfusion-mcp](https://github.com/Articulated7/enfusion-mcp)** — original project

Forge-X rebrand by [Dopemodz420](https://github.com/Dopemodz420). Used and modified with permission. MIT licensed.

## License

MIT — see [LICENSE](LICENSE)
