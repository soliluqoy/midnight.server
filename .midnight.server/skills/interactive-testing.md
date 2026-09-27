---
name: interactive-testing
description: Test and debug midnight.server's interactive mode in a controlled terminal. Use for TUI behavior checks and interactive release smoke tests.
---

# Testing Interactive Mode

Run the TUI from the repo root (two directories above this skill).

On Linux, macOS or WSL, use tmux:

```bash
tmux new-session -d -s ms-test -x 80 -y 24
tmux send-keys -t ms-test "./pi-test.sh" Enter
sleep 3 && tmux capture-pane -t ms-test -p     # capture after startup
tmux send-keys -t ms-test "your prompt here" Enter
tmux send-keys -t ms-test Escape               # special keys (also C-o for ctrl+o, etc.)
tmux kill-session -t ms-test
```

On Windows without tmux, run `.\pi-test.ps1` in a separate Windows Terminal tab and ask the user to report or screenshot what it shows.

For release smoke tests, start the session outside the repo (`tmux new-session -c /tmp ...`) and replace `./pi-test.sh` with the absolute path to the release binary. Submit a prompt and wait for the model reply; startup alone is not a passing smoke test.
