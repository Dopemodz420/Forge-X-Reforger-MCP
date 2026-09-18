# Contributing to ReforgerForge MCP

Thanks for helping improve ReforgerForge MCP!

## Agent Setup

See [README.md](README.md#agent-setup) for full instructions. Quick install:

```powershell
.\scripts\install-agents.ps1 -All          # all supported agents
.\scripts\install-agents.ps1 -Agent antigravity   # Google Antigravity only
```

Supported agents: Cursor, Google Antigravity, Claude Desktop, Windsurf, VS Code Copilot, Continue.dev, Kiro.

## Making Changes

1. Create a branch: `git checkout -b feature/your-feature`
2. Make your changes in `src/`
3. Run tests: `npm test`
4. Build: `npm run build`
5. Verify tools: `node scripts/list-tools.mjs`
6. Open a pull request

## Code Style

- TypeScript strict mode
- Match existing patterns in `src/tools/`
- Logger writes to **stderr only** (stdio MCP transport requirement)
- No `console.log` in server code

## Reporting Issues

Open an issue at https://github.com/Dopemodz420/Forge-X-Reforger-MCP/issues with:

- Your agent (Cursor, Claude, etc.)
- Node.js version
- Error message or unexpected behavior
- Steps to reproduce

## Upstream

This project is forked from [steffenbk/enfusion-mcp-BK](https://github.com/steffenbk/enfusion-mcp-BK). When fixing bugs that exist upstream, consider contributing back.

## License

By contributing, you agree your contributions are licensed under the MIT License.
