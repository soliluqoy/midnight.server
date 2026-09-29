# Quickstart

midnight.server runs in your terminal and works with files on your machine. To use it, you need access to a model through a supported provider. This can be a subscription, an API key, or a local model.

For native Windows setup, read [Windows Setup](windows.md). For Android, read [Termux Setup](termux.md).

## 1. Install midnight.server

On macOS or Linux, you can use the installer:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Alternatively, install midnight.server from npm. This requires Node.js 22.19 or newer:

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
```

midnight.server does not require dependency lifecycle scripts for a normal npm installation.

Verify the installation:

```bash
midnight.server --version
```

## 2. Start midnight.server

Change to the folder you want midnight.server to work with, then start it:

```bash
cd /path/to/folder
midnight.server
```

The working folder helps midnight.server discover relevant files, instructions, and configuration. midnight.server also uses it to group saved sessions.

<p align="center"><img src="images/interactive-mode.png" alt="midnight.server running in a terminal with a conversation, input editor, and status footer" width="750"></p>

The interface shows your conversation, an editor for prompts and commands, and a footer with the current folder, model, and session status. See [Use midnight.server in the terminal](usage.md) to learn how to add files, run commands, direct ongoing work, and manage results.

## 3. Choose a model

A **model** generates midnight.server's responses. A **provider** is the service or account midnight.server uses to access that model.

In midnight.server, run:

```text
/login
```

Choose a provider, then follow the prompts to use a subscription or store an API key. Run `/model` afterward if you want to select a different available model.

See [Choose a model and provider](models.md) for supported providers, environment-variable authentication, local models, and custom endpoints.

## 4. Give midnight.server a task

midnight.server shows each file read, search, command, and edit it performs. It does not ask before every tool call.

Enter a task that matches your work, for example:

```text
Summarize @meeting-notes.md and save the action items to action-items.md.
```

```text
Explain how this repository is structured and how to run its checks.
```

```text
Compare @previous.csv with @current.csv and summarize the important changes.
```

Type `@` in the editor to search for a file instead of entering its full path. When midnight.server finishes, review its response and any changed files. Use version control or backups for important work. For untrusted or unattended work, use a container or another sandbox. See [Security](security.md).

## Continue later

midnight.server saves sessions automatically. Exit midnight.server, then resume the most recent session for the same working folder with:

```bash
midnight.server --continue
```

Use `/resume` to choose another saved session. See [Continue or branch a session](sessions.md) for session naming, branching, compaction, export, and sharing.

## Next steps

- [Use midnight.server interactively](usage.md) to learn input, commands, shortcuts, and queued messages.
- [Add instructions](configuration.md#context-files) that midnight.server should follow whenever it works in a folder.
- [Choose a model and provider](models.md).

### Choose how to customize midnight.server

Start with the least powerful mechanism that meets your need:

| Need | Start with |
|---|---|
| Give midnight.server persistent instructions for a folder | [`AGENTS.md`](configuration.md#context-files) |
| Reuse a prompt from the `/` menu | [Prompt template](prompt-templates.md) |
| Add task-specific instructions and supporting files | [Skill](skills.md) |
| Add executable tools, commands, or event handlers | [Extension](extensions.md) |
| Build a custom terminal component | [Terminal UI](tui.md) |
| Connect an unsupported model service | [Custom provider](custom-provider.md) |
| Install or distribute several resources | [midnight.server package](packages.md) |

## Uninstall midnight.server

If you installed midnight.server with npm, run:

```bash
npm uninstall -g @earendil-works/pi-coding-agent
```

If you used the installer, run it again and choose **Uninstall midnight.server**:

```bash
curl -fsSL https://pi.dev/install.sh | sh
```

Neither method removes configuration, credentials, sessions, or installed midnight.server packages from `~/.midnight.server/agent/`.
