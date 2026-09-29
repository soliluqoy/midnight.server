# Contributing to midnight.server

## The One Rule

**You must understand your code.** If you cannot explain what your changes do and how they interact with the rest of the system, your PR will be closed. Using AI to write code is fine; submitting AI-generated code you do not understand is not.

If you use an agent, run it from the repository root so it picks up `AGENTS.md` (and `CLAUDE.md` for Claude Code). Your agent must follow the rules in that file.

## Issues

Use the bug report template at https://github.com/soliluqoy/midnight.server/issues. Keep it short and concrete: what happened, how to reproduce it, what you expected, and the version (`midnight.server --version`). For a crash or hang, attach the archive written by `/bug`. Before reporting, check that the problem also happens without your own extensions (`midnight.server -ne`).

## Pull Requests

Open an issue first for anything larger than a small fix, so the approach can be agreed before you write it.

Before submitting a PR:

```bash
npm run check
./test.sh
```

Both must pass (see `docs/IMPLEMENTATION_STATUS.md` for known Windows baseline failures). Do not edit `CHANGELOG.md`; the maintainer adds the entry.

If you are adding a new LLM provider to `packages/ai`, follow `.midnight.server/skills/add-llm-provider.md`.
