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
- A rewind reconciles only the paths whose **recorded** checkpoint deltas after the chosen checkpoint changed; edits made outside the captured timeline are left untouched. A path that exists only after it is deleted; the preview names each restore and deletion, and the mandatory recovery snapshot and journal precede them. Midnight's own confirmed restores are recorded, so an earlier restore can be rewound before the next snapshot. A files-only restore of an imported legacy snapshot uses the pending paths recorded inside that snapshot and can overwrite later edits to them. An import adds no delta to the timeline, and a snapshot imported before provenance was recorded has no marker: import it again before relying on that fallback.
- Midnight makes a mandatory recovery snapshot and journal before file changes. Unrelated paths are preserved and a changed branch refuses restore. If commits were made after the chosen checkpoint, the confirmed restore moves the branch back to the checkpoint commit and restores the paths those commits changed; the preview lists the commits leaving the branch. The old tip stays in the reflog and the recovery checkpoint, and redo moves the branch forward again. Tell the user this before they confirm.
- /midnight checkpoints redo offers the pre-restore state. /midnight checkpoints recover previews a leftover failure journal. Never invent automatic rollback or silently discard a journal.
- Conversation-tree navigation alone never restores disk contents.
- Legacy migration uses /midnight checkpoints legacy and /midnight checkpoints import. Import adds native refs/metadata only; original refs are retained. Import does not become a recorded delta, and conversation mapping is unavailable for legacy imports.

Ask the user to invoke interactive restore controls; these commands are not general agent tools or permission to bypass confirmation. In non-interactive modes, explain that restoration is unavailable rather than emulating it through shell commands.

Do not use blanket git clean, run git reset yourself, initialize Git silently, or overwrite unrelated edits to imitate rewind. Local Git objects may persist after refs are pruned, and exclusions are not secret detection. Never promise perfect recovery or secret-proof storage.
