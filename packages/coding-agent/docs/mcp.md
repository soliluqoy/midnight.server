# MCP

midnight.server ships [pi-mcp-adapter](https://github.com/nicobailon/pi-mcp-adapter) as a built-in extension, so `/mcp` works on a fresh install with no `install` step.

The adapter keeps MCP cheap:

- The model sees one `mcp` proxy tool (about 200 tokens) and searches for server tools on demand, instead of every tool schema sitting in the system prompt.
- Servers connect lazily on first use; tool metadata is cached between runs.
- Frequently used tools can be promoted to direct tools per server with `directTools`.

## Commands

- `/mcp`: server status and setup panel
- `/mcp-auth <server>`: OAuth login for a server
- `/skill:mcp-scripting`: guidance for scripting MCP calls

## Configuration

Config files merge in this order (later wins):

1. `~/.config/mcp/mcp.json`
2. `~/.agents/mcp.json`, `~/.agents/mcp/mcp.json`
3. `~/.midnight.server/agent/mcp.json`
4. `.mcp.json` in the project (the same file Claude Code uses)
5. `.midnight.server/mcp.json` in the project

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "."]
    }
  }
}
```

See the [adapter README](https://github.com/nicobailon/pi-mcp-adapter#readme) for HTTP servers, OAuth, `directTools`, and importing configs from Claude Code, Cursor, Codex and others.

## Bundling and overrides

Bundled extensions live in `extensions/` next to `midnight.server.exe` (`packaging/extensions/` in a source checkout) and are pinned by that directory's `package-lock.json`.

- `midnight.server install npm:pi-mcp-adapter@<version>` replaces the bundled copy with your own version; the bundled one is skipped while settings list the same npm package.
- `MIDNIGHT_SERVER_NO_BUNDLED_EXTENSIONS=1` skips all bundled extensions. `--no-extensions` does too.
