# Changelog

## [Unreleased]

## [0.99.1-midnight.1] - 2026-09-30

### Added

- `workerUrl` accepts a path string, which Bun compiled executables need to load an embedded worker entrypoint.

## [0.99.1] - 2026-09-29

## [0.99.0] - 2026-09-29

### Added

- Initial spike: `CodemodeSandbox` runs model-written JavaScript in a worker thread and exposes injected tools as `tools.<name>(args)` async functions.
