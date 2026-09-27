---
name: release
description: Prepare, tag, verify and publish a midnight.server GitHub release (Windows x64, Linux x64, macOS arm64). Use for release preparation, release smoke tests, and failed release CI.
---

# Releasing midnight.server

Run commands from the repo root (two directories above this skill). Releases are GitHub releases only; nothing is published to npm.

Tag format: `v<pi-version>-midnight.<n>`. `<pi-version>` is the Pi base in `packages/coding-agent/package.json` (e.g. `0.87.1`); `<n>` is the next number after the latest tag on that base (`git tag --list 'v0.87.1-midnight.*' --sort=-v:refname | head -1`) and restarts at 1 when the Pi base changes.

1. **Start from a clean, current `main`** with every release PR merged and CI green.

2. **Audit the changelog**: run the `cl` prompt (`.midnight.server/prompts/cl.md`) so every commit since the last tag has an entry under `## [Unreleased]`.

3. **Cut the version section** on a branch `chore/release-<n>`: in each `packages/*/CHANGELOG.md` whose `## [Unreleased]` has entries, rename it to `## [<pi-version>-midnight.<n>] - <YYYY-MM-DD>` and add an empty `## [Unreleased]` above it. Preview the notes with `npm run release:notes -- v<pi-version>-midnight.<n>`. Commit `docs: release v<pi-version>-midnight.<n>`, open a PR, merge it.

4. **Local smoke test** (Windows, PowerShell), optional when CI is trusted but required after packaging or engine changes:
   ```powershell
   scripts\bootstrap.ps1 -Install
   scripts\build.ps1
   scripts\package.ps1
   scripts\verify-release.ps1 -Package dist\midnight.server-windows-x64.zip
   ```
   Then start the built binary from a directory outside the repo, check `--version`, `--list-models`, `-p "Say exactly: ok"`, and one interactive prompt (see [interactive-testing.md](interactive-testing.md)). Failures block the release unless the user accepts the risk.

5. **Tag and push** from the merged `main`:
   ```bash
   git switch main && git pull --ff-only
   git tag v<pi-version>-midnight.<n>
   git push origin v<pi-version>-midnight.<n>
   ```
   Pushing a tag is outward-facing; confirm with the user first.

6. **CI builds the draft**: `.github/workflows/midnight-release.yml` builds and verifies Windows x64, Linux x64 (`.deb` installed and run) and macOS arm64, then creates a draft release whose notes are the tag's `packages/coding-agent/CHANGELOG.md` section plus install instructions, with the archives and `SHA256SUMS` attached. Watch it with `gh run watch`.

7. **Review and publish**: `gh release view <tag>`; edit the notes only if needed (`gh release edit <tag> --notes-file <file>`), then `gh release edit <tag> --draft=false` after the user confirms.

## Recovery

- A failed job: fix the cause on a branch, merge, then rerun the workflow for the same tag with `gh workflow run midnight-release.yml -f tag=<tag>` only if the fix does not change the release contents; otherwise delete the draft and tag (with the user's consent) and release the next `<n>`.
- The notes step fails with "has no ## [...] section": step 3 was skipped. Merge the changelog cut, move the tag only with the user's consent, or release the next `<n>`.
- A dry run of any ref: `gh workflow run midnight-release.yml -f tag=main -f publish=false`.
