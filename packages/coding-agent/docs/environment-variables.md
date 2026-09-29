# Environment Variables

midnight.server uses environment variables in three ways:

- Variables such as `MIDNIGHT_SERVER_OFFLINE` configure the midnight.server process.
- midnight.server sets process markers so child processes can identify midnight.server as the launching agent.
- Commands run by the LLM-callable shell tools receive `PI_*` variables describing the current session.

Provider API-key variables are documented separately in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).

## Process Marker

The CLI and RPC entry points set two process markers:

- `AI_AGENT=midnight.server` is a generic marker that lets tooling identify midnight.server as the agent that launched the process.
- `MIDNIGHT_SERVER_CODING_AGENT=true` is midnight.server-specific and lets child processes detect that they run inside midnight.server.

Child processes inherit both markers. They are not session-specific and are not set automatically when midnight.server is embedded through the SDK.

## Shell Tool Session Environment

Commands run by the `bash` and `powershell` tools receive the current midnight.server session state:

| Variable | Description |
|----------|-------------|
| `MIDNIGHT_SERVER_SESSION_ID` | Current session ID |
| `MIDNIGHT_SERVER_SESSION_FILE` | Absolute path to the current session JSONL file; unset for ephemeral sessions |
| `MIDNIGHT_SERVER_PROVIDER` | Currently selected model provider |
| `MIDNIGHT_SERVER_MODEL` | Currently selected model ID |
| `MIDNIGHT_SERVER_REASONING_LEVEL` | Current effective reasoning level: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max` |

The values are resolved when each command starts. Switching models or changing the reasoning level therefore affects the next shell command without restarting midnight.server. `MIDNIGHT_SERVER_PROVIDER` and `MIDNIGHT_SERVER_MODEL` identify the selected midnight.server model, not a different upstream model that a router may choose internally.

When asked which model or provider is running, inspect these variables instead of inferring the answer from the system prompt:

```bash
printf '%s/%s\n' "$MIDNIGHT_SERVER_PROVIDER" "$MIDNIGHT_SERVER_MODEL"
printf 'reasoning=%s session=%s\n' "$MIDNIGHT_SERVER_REASONING_LEVEL" "$MIDNIGHT_SERVER_SESSION_ID"
```

The session file can be inspected directly when the session is persistent:

```bash
if [ -n "$MIDNIGHT_SERVER_SESSION_FILE" ]; then
  tail -n 1 "$MIDNIGHT_SERVER_SESSION_FILE"
fi
```

These variables are injected into the LLM-callable `bash` and `powershell` tools. They are not injected into user-entered `!` or `!!` commands.

### Custom Shell Tools

Tools created with `createBashTool()` or `createPowerShellTool()` expose the session environment by default when registered with midnight.server. Injection happens before `spawnHook`, so a hook receives the variables in `ctx.env`:

```typescript
const bashTool = createBashTool(cwd, {
  spawnHook: (ctx) => ({
    ...ctx,
    env: { ...ctx.env, CI: "1" },
  }),
});
```

Disable session metadata independently of the spawn hook:

```typescript
const powershellTool = createPowerShellTool(cwd, {
  exposeSessionEnvironment: false,
  spawnHook: (ctx) => ctx,
});
```

When disabled, midnight.server removes inherited values for these variables so nested midnight.server processes do not expose stale parent-session metadata.

## midnight.server Process Configuration

These variables are read by midnight.server itself:

| Variable | Description |
|----------|-------------|
| `MIDNIGHT_SERVER_CODING_AGENT_DIR` | Override the config directory; default is `~/.midnight.server/agent` |
| `MIDNIGHT_SERVER_CODING_AGENT_SESSION_DIR` | Override session storage; overridden by `--session-dir` |
| `MIDNIGHT_SERVER_PACKAGE_DIR` | Override the package directory, useful for Nix/Guix store paths |
| `MIDNIGHT_SERVER_OFFLINE` | Disable automatic network activity, including model catalog refreshes |
| `MIDNIGHT_SERVER_SKIP_VERSION_CHECK` | Disable the `pi.dev` latest-version request |
| `MIDNIGHT_SERVER_TELEMETRY` | Override install/update telemetry and provider attribution headers: `1`/`true`/`yes` or `0`/`false`/`no` |
| `MIDNIGHT_SERVER_CACHE_RETENTION` | Set to `long` for extended provider prompt caching where supported |
| `MIDNIGHT_SERVER_SHARE_VIEWER_URL` | Override the base URL used by `/share` |
| `MIDNIGHT_SERVER_RADIUS_GATEWAY` | Override the Radius gateway origin used by Radius relay connections |
| `MIDNIGHT_SERVER_HARDWARE_CURSOR` | Set to `1` to show the hardware cursor; see [Terminal setup](terminal-setup.md) |
| `MIDNIGHT_SERVER_HYPERLINKS` | Override OSC 8 hyperlink detection with `1`, `0`, or `auto` |
| `MIDNIGHT_SERVER_IMAGE_PROTOCOL` | Override inline image detection with `kitty`, `iterm2`, `none`, or `auto` |
| `MIDNIGHT_SERVER_TRUE_COLOR` | Override truecolor detection with `1`, `0`, or `auto` |
| `MIDNIGHT_SERVER_TUI_ESC_TIMEOUT` | How long to wait after a lone ESC before treating it as Escape, in milliseconds; defaults to `100` over SSH and `10` otherwise. Increase if Alt-key input is misread as Escape |
| `VISUAL`, `EDITOR` | External editor fallback when `externalEditor` is unset |
| `HTTP_PROXY`, `HTTPS_PROXY` | Proxy outbound HTTP requests |

Provider credentials such as `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and cloud-provider configuration are listed in [Provider Authentication](providers.md#use-an-api-key-from-the-environment).
