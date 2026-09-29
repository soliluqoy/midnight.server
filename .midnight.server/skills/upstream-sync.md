---
name: upstream-sync
description: Merge a new Pi (earendil-works/pi) release into midnight.server and verify it. Use when Pi publishes a new version, or when asked to update the Pi base.
---

# Merging a Pi release

Run commands from the repo root (two directories above this skill). Pi is an ancestor of `main` (see "Upstream base" in `docs/IMPLEMENTATION_STATUS.md`), so a Pi release is an ordinary `git merge`: only lines both sides changed conflict.

1. **Fetch upstream** and pick the release tag:
   ```bash
   git remote get-url upstream || git remote add upstream https://github.com/earendil-works/pi.git
   git fetch upstream --tags
   git tag --list 'v0.*' --sort=-v:refname | grep -v midnight | head -3
   ```
   Read the `### Breaking Changes` of every package changelog between the current base (`packages/coding-agent/package.json` version) and the target before merging.

2. **Merge on a branch** `chore/pi-<version>` from a clean `main`, in a separate worktree when the main checkout has uncommitted work:
   ```bash
   git worktree add ../midnight-pi-<version> -b chore/pi-<version> main
   git -c merge.renameLimit=20000 merge v<version>
   ```

3. **Resolve conflicts** by kind:
   - Files midnight deleted (upstream release scripts and workflows, the llama.cpp extension, the Earendil announcement): keep them deleted (`git rm`). Also delete new upstream files that only serve deleted ones, such as tests of removed scripts.
   - `CHANGELOG.md`: keep `## [Unreleased]` with our entries on top, then upstream's new released sections, then our released `-midnight.<n>` sections unchanged.
   - Docs: take upstream's text and rebrand it like the rest (prose `Pi`/`pi` and CLI commands become `midnight.server`, `.pi/` and `~/.pi` become `.midnight.server`); keep `pi.` API identifiers, `pi-*` package names and `pi.dev`. Keep midnight-only pages (`harness.md`, `windows.md`) ours.
   - Source: combine both sides. Upstream's version wins where midnight only carried an optimization upstream has since made itself; midnight's behavior wins where it is deliberate and tested (keybindings, Windows defaults, footer and startup header, themes, `/bug` export, update checker).
   - Theme JSON (`dark.json`, `light.json`): take midnight's files whole, then check them against `theme-schema.json`; line merges mix palettes.

4. **Rename what upstream added.** Search the lines upstream added for Pi naming and convert them:
   ```bash
   git diff -U0 <old-base> v<version> -- packages/ | grep -nE '^\+.*(PI_[A-Z_]{3,}|"\.pi"|\.pi/)'
   ```
   `PI_*` environment variables become `MIDNIGHT_SERVER_*`; `.pi` paths use `CONFIG_DIR_NAME` in source and tests.

5. **Hydrate and install**: `npm install --ignore-scripts`, then `npm run hydrate:model-data` when the model data schema changed. The lockfile and shrinkwrap changes are part of the merge.

6. **Verify** (the user's request to update Pi covers building and testing):
   - `npm run check`, `npm run build`.
   - Midnight tests: `packages/coding-agent/test/harness-*.test.ts`, `test/midnight-*.test.ts`, `test/suite/harness*.test.ts`.
   - `./test.sh` on the merge and on `main` in a second worktree; every failure on the merge must also fail on `main` or be explained. `docs/IMPLEMENTATION_STATUS.md` lists the known Windows failures.
   - Windows binary: `scripts\bootstrap.ps1`, `scripts\build.ps1`, `scripts\package.ps1`, `scripts\verify-release.ps1`. Run the binary from a directory outside the repo: `--version`, `-p "Say exactly: ok"`, and every new worker or wasm the release adds (upstream's `scripts/build-binaries.sh` lists its extra entrypoints; midnight's build scripts must pass the same ones).

7. **Record it**: update "Upstream base" in `docs/IMPLEMENTATION_STATUS.md` and `docs/upstreams.lock.json`, add `## [Unreleased]` entries, commit `chore: merge Pi v<version>` as a merge commit (never squash: the merge parent is what keeps Pi in history), and open a PR. The next release restarts `<n>` at 1 (see [release.md](release.md)).
