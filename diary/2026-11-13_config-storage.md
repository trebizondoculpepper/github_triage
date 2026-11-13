# Development Diary Entry - 2026-11-13

## Problem Statement

Issue #116: a shared, typed configuration service for the versioned non-secret `.github/triage.json`, following `doc/design/repository-configuration.md`. CLI commands are #117.

## Implementation

`src/config.ts` holds the key registry (`complexity.enabled` default true, nullable `complexity.fieldId` unset), a declarative migration list, read-only `loadConfig`, `resolveRepositoryTarget` (verifies the checkout's GitHub remotes match `--repo` before any write) and `updateConfig` (in-memory migration, validation, temp file plus rename, refusal when the file changed since it was read, no-op for equal writes). Filesystem and git are injected boundaries.

## Outcomes

Schema version 1 is the first schema, so the shipped migration list is empty; migrations are tested with an injected schema. The conflict check narrows but cannot fully close the window between the final re-read and rename without OS locking, which the design does not require.

## Next Steps

#117 wires `config get/set/list/help` to this service.
