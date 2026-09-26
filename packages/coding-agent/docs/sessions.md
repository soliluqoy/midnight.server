# Sessions and Context

midnight.server saves a conversation as a session. The active branch of that session supplies conversation history for the next model request. Use session commands to continue work, explore another branch, or reduce the amount of history sent to the model.

## Continue or switch sessions

midnight.server saves sessions automatically unless you start it with `--no-session`.

```bash
midnight.server --continue
midnight.server --resume
```

`--continue` opens the most recent session for the current working directory. `--resume` opens the session picker. In interactive mode, `/resume` opens the same picker and `/new` starts a new session.

Use `/name` or `--name` to assign a recognizable session name. Run `/session` to verify the current session file, ID, message count, token usage, and cost.

The session picker lets you search, rename, and delete sessions. It can also show paths, change sorting, and limit results to named sessions. See [Keybindings](keybindings.md#sessions) for its shortcuts.

## Choose how to branch

midnight.server stores entries as a tree, so returning to an earlier point does not erase the branch you leave.

| Action | Result | Use it when |
|---|---|---|
| `/tree` | Moves within the current session file | Related alternatives should stay together |
| `/fork` | Creates a new session from an earlier user message | The alternative should become separate work |
| `/clone` | Copies the active branch into a new session | You want a separate copy of the current state |

In `/tree`, select a user message to put its text back in the editor. Edit and submit it to create another branch. Selecting an assistant response or another entry continues after that entry with an empty editor.

When you leave a branch, midnight.server can summarize it and attach that summary to the branch you enter. This preserves relevant work from the abandoned path without including every message from it.

For the persisted tree and entry types, see [Session Format](session-format.md).

## Manage conversation context

The model receives the active branch, not every branch in the session file. midnight.server combines that history with the system prompt, discovered context files, available tools, and loaded skill descriptions. [How midnight.server Works](how-pi-works.md#context) describes how those inputs are assembled.

The footer shows current context usage. When the active context approaches the model's limit, midnight.server normally compacts older history automatically. Compaction adds a summary and keeps recent messages. It does not delete the original session entries.

Run `/compact` to compact manually. You can add instructions when the summary should preserve a particular topic or decision. Configure automatic compaction and retained history through [Settings](settings.md#compaction).

Compaction can fail if the provider is unavailable or cannot accept the summarization request. Correct the provider problem and run `/compact` again. Disabling automatic compaction does not disable the manual command.

See [Compaction Reference](compaction.md) for thresholds, retained boundaries, branch-summary behavior, and extension hooks.

## Ask side questions

A side thread is a short question about one item in the transcript, such as a failed command or a reply. The answer appears folded under that item. The main agent never sees it, keeps running while you ask, and your prompt draft is kept.

1. Press `alt+t`. The newest tool call or reply is highlighted. Use up/down to pick another item, or alt+click it.
2. Press Enter. A line above the editor shows the item and the model. Press `ctrl+p` (or Tab in an empty editor) to switch models, type the question, and press Enter. Escape goes back without asking.
3. The answer streams under the item. With the item selected, Space opens or folds its thread, Enter asks a follow-up, `x` stops a running answer, `d` deletes the thread, and `m` sends the thread to the main agent.

`/ask [question]` asks about the newest item without selecting it. Start the question with `@local`, `@same`, or `@provider/model` to choose the model.

The model decides how much context the question carries:

| Model | Request |
|---|---|
| Same model as the session | The main agent's last request plus the question, so the provider can reuse its prompt cache |
| Local model | The item only, clipped to about 6 KB, plus earlier answers in the thread |
| Another model | The item, recent conversation text, and earlier answers in the thread |

The default is the local model for tool output when it is installed, otherwise the session model. The choice you make with `ctrl+p` is kept for later questions until you quit.

Threads are saved beside the session file as `<session>.threads.json`, so they come back when you resume. They are not session entries: `/tree`, `/fork`, and compaction ignore them, and a fork starts without threads. `m` is the only way a thread reaches the main agent: it adds the unsent questions and answers as a visible message. If the agent is running, the message is added when the current turn ends. No turn is started.

## Control session storage

By default, midnight.server stores sessions under `~/.midnight.server/agent/sessions/`, grouped by working directory. Use `--session-dir`, `MIDNIGHT_SERVER_CODING_AGENT_SESSION_DIR`, or the `sessionDir` setting to choose another location. The CLI option has highest precedence.

Use `--no-session` for an ephemeral run. An ephemeral session cannot be resumed after midnight.server exits.

Use `--session` when you already know the session path or ID. Use `--fork` to create a new session from an existing session before interactive mode starts.

## Export or share a session

Use `/export` to write the current session as HTML or JSONL. Use `/share` to upload it and get a viewer link. midnight.server uses a Radius artifact when Radius authentication is configured; otherwise, it uses a private GitHub gist.

HTML exports and shares include side threads, folded under their items. JSONL exports contain only the session file.

Review exported or shared sessions first. They can contain prompts, model responses, tool arguments, command output, file contents, and extension messages.

## Report a bug

Run `/bug [description]` to prepare a bug report for the midnight.server developers. You can include the session transcript, omit it, or ask the current model to summarize the problem. Review any transcript or generated summary because it can contain sensitive conversation data.

The report includes environment and provider configuration without credential values, plus recorded error diagnostics. midnight.server exports it as a zip archive in the current directory and never uploads it; inspect the archive, then attach it to an issue at https://github.com/soliluqoy/midnight.server/issues.
