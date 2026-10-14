---
name: midnight-checkpoints
description: Explain or safely use Midnight checkpoints when a user wants to rewind coding work, inspect restore coverage, redo a restore, or recover an incomplete restore. Do not substitute Git reset/clean or silently change files during conversation navigation.
compatibility: Pi with native Midnight checkpoint ownership, Git on PATH, and an interactive session for restoration.
---

# Safe checkpoint workflow

Checkpoints describe observed pending state, not exact session authorship. Inspect /midnight status and /midnight checkpoints status before suggesting a restore.

- /midnight checkpoints capture records a manual snapshot. Capture does not commit user work or move Git HEAD.
- /midnight rewind opens the picker. The user chooses files and conversation, files only, or conversation only.
- File restores require a full read-only preview and explicit confirmation. Explain deletions, staged/unstaged changes, exclusions and missing coverage; never assume an excluded path was clean.
- Midnight makes a mandatory recovery snapshot and journal before file changes. Unrelated paths and Git HEAD are preserved; a changed HEAD/branch refuses ordinary restore.
- /midnight checkpoints redo offers the pre-restore state. /midnight checkpoints recover previews a leftover failure journal. Never invent automatic rollback or silently discard a journal.
- Conversation-tree navigation alone never restores disk contents.
- Legacy migration uses /midnight checkpoints legacy and /midnight checkpoints import. Import adds native refs/metadata only; original refs are retained. Conversation mapping is unavailable for legacy imports.

Ask the user to invoke interactive restore controls; these commands are not general agent tools or permission to bypass confirmation. In non-interactive modes, explain that restoration is unavailable rather than emulating it through shell commands.

Do not use blanket git clean, reset HEAD, initialize Git silently, or overwrite unrelated edits to imitate rewind. Local Git objects may persist after refs are pruned, and exclusions are not secret detection. Never promise perfect recovery or secret-proof storage.
