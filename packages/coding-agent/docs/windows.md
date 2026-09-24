# Windows Setup

midnight.server runs natively on Windows without Git Bash, WSL, Node.js or Python.

## Default shell: PowerShell

On Windows, the model-facing shell tool is `powershell` and the `!` / `!!` editor commands run through PowerShell. It uses `pwsh.exe` when available, otherwise Windows PowerShell 5.1, and starts it with `-NoProfile -NonInteractive -ExecutionPolicy Bypass`. Administrator-enforced execution policies can still take precedence.

To use Bash instead (Git Bash, Cygwin, MSYS2), select the `bash` tool:

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

Without `shellPath`, the `bash` tool looks for Git Bash (`C:\Program Files\Git\bin\bash.exe`), then `bash.exe` on PATH.

## Local model

See [the midnight.server README](../../../README.md) for `--local`, `--hybrid`, `model fetch`, `engine fetch` and `doctor`. The engine runs in a Windows Job Object owned by the CLI, so it exits when the CLI exits, including after a crash.

## Security note

A shell tool runs with your user's full permissions. midnight.server does not sandbox PowerShell or Bash. The local helper (`delegate_local`, `helper`) has no shell access and reads only the files it is given inside the workspace.
