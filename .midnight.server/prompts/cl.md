---
description: Audit changelog entries before release
---
Audit changelog entries for all commits since the last release.

## Process

1. **Find the last release tag:**
   ```bash
   git tag --list 'v*-midnight.*' --sort=-v:refname | head -1
   ```

2. **List all commits since that tag:**
   ```bash
   git log <tag>..origin/main --oneline --no-merges
   ```

3. **Read the `## [Unreleased]` section of every `packages/*/CHANGELOG.md`** that the commits touch (usually `coding-agent`, `ai`, `tui`, `agent`).

4. **For each commit, check:**
   - Skip: changelog updates, doc-only changes, release housekeeping, CI-only changes.
   - Skip: changes to generated model catalogs (for example `packages/ai/src/models.generated.ts`) unless accompanied by an intentional product-facing change in non-generated source/docs.
   - Skip: fixes to a feature that is itself still unreleased; the feature's entry covers it (update that entry if the behavior it describes changed).
   - Determine which package(s) the commit affects (`git show <hash> --stat`).
   - Verify a changelog entry exists in the affected package(s).
   - For external contributions, verify the format: `Description ([#N](https://github.com/soliluqoy/midnight.server/pull/N) by [@user](https://github.com/user))`.

5. **Cross-package rule:** user-facing changes in `ai`, `agent` or `tui` are also entered in `packages/coding-agent/CHANGELOG.md`, because its section becomes the release notes.

6. **Report and fix:**
   - List commits with missing entries and entries missing from `coding-agent`.
   - Add the missing entries directly, following the changelog rules in `AGENTS.md`.
   - Show the resulting release notes: `npm run release:notes -- <next-tag>` works once the section is cut; before that, show the `coding-agent` `[Unreleased]` section.
