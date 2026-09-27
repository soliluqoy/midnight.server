# Run midnight.server on Windows

midnight.server runs natively on Windows without Git Bash, WSL, Node.js or Python. It can also run inside Windows Subsystem for Linux (WSL), where it uses the Linux environment and its Bash installation.

Follow the main [Quickstart](quickstart.md) to install and authenticate midnight.server. Use this page to choose and configure its command environment.

## Default shell: PowerShell

On native Windows, the model-facing shell tool is `powershell` and the `!` / `!!` editor commands run through PowerShell. It uses `pwsh.exe` when available, otherwise Windows PowerShell 5.1, and starts it with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

To use Bash instead (Git Bash, Cygwin, MSYS2), select the `bash` tool in `~/.midnight.server/agent/settings.json`:

```json
{
  "defaultTools": ["read", "bash", "edit", "write"]
}
```

Or enable both while comparing behavior:

```json
{
  "defaultTools": ["read", "bash", "powershell", "edit", "write"]
}
```

Setting `shellPath` also routes `!` and `!!` through that Bash:

```json
{
  "shellPath": "C:\\Program Files\\Git\\bin\\bash.exe"
}
```

JSON uses backslashes for escape sequences. When you write a Windows path with backslashes, write each backslash twice, as shown above.

Without `shellPath`, the `bash` tool looks for Git Bash under `Program Files` or `Program Files (x86)`, then `bash.exe` on `PATH`. See [Configure shell commands](shell-aliases.md) for command prefixes, aliases, and the complete shell-resolution behavior.

## Configure Windows Terminal

Windows Terminal reserves or rewrites some modified keys. See [Windows Terminal](terminal-setup.md#windows-terminal) to configure `Shift+Enter` and `Alt+Enter`, and [Keybindings](keybindings.md) for midnight.server's Windows and WSL shortcut defaults.

## Security note

A shell tool runs with your user's full permissions. midnight.server does not sandbox PowerShell or Bash.
