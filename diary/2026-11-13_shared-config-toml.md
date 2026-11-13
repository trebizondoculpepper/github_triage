# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 UTC
- **Branch**: issue-160-shared-config-toml
- **Contributors**: Claude Code + User

## Problem Statement

Issue #160: move shared repository settings from `.github/triage.json` to `.github/triage.toml` without losing data, without automatic migration and without a hidden precedence rule when both files exist.

## Our Approach

The merged contract (doc/design/configuration-formats.md) already fixed the file name, the conflict rule, the explicit config-mediated conversion and the preserve-until-verified rule, and left only the command syntax to the implementer, so no separate contract PR was needed. The existing configuration service gained a format dimension instead of a new framework, and the identity service's smol-toml parse boundary moved into config.ts so both stores share it.

## Implementation

- `src/config.ts`: `TOML_CONFIG_PATH`/`LEGACY_CONFIG_PATH`, `parseTomlTable` (shared with identity), format-aware `parseConfig`/`serializeConfig`, `loadConfig` and `updateConfig` refusing both files (`duplicate-config`), atomic writes re-checking both stores before the rename, and `convertConfig` (write, read back and compare, then remove the unchanged JSON; `partial-conversion` otherwise).
- `src/configcli.ts`: `config convert [--prefer toml|json]`, additive `storage` object, legacy notice, help.
- Tests in `src/triage.test.ts` with an injected filesystem covering typed values, unknown keys, old/future schema, malformed TOML, concurrency, conversion failures and the real filesystem.

## Outcomes

TOML integers are parsed as BigInt, so `schemaVersion = 1.0` is refused rather than accepted as 1, and error messages had to stop using `JSON.stringify` for values. A test hook that fires inside `rename` runs after the conflict re-check, so concurrency is simulated after the temporary write instead.

## Next Steps

Convert repositories that still carry `.github/triage.json` with `github-triage config convert` and commit the result.
