# Development Diary Entry - 2026-11-13

## Context

- **Date**: 2026-11-13 UTC
- **Branch**: issue-71-workflow-explain
- **Contributors**: Claude Code (kavya_sabbagh) + owner

## Problem Statement

Issue #71: explain the project workflow in `--help` and briefings, generated from registered policy, bounded, with a per-project opt-out (contract doc/design/workflow-guide.md).

## Our Approach

New `src/process.ts` generates guide rules from `pickupPolicy`, `pickupOrders`, `claimPolicy`, `roleRegistry`, `briefingStaleHours` and a registry of implemented commands. The policy version is a sha256 of the canonical (sorted-key) rules and commands. The opt-out is a `processGuide` key in the existing configuration registry rather than the separate file the earlier contract named, because #116 shipped a shared configuration service in the meantime.

## Implementation

Compact text appends the guide after all evidence within `--max-chars`, otherwise prints the pointer with an omission notice. JSON gets an additive `process` object. `--guide`/`--no-guide` override; config problems fall back to the default with a diagnostic. `github-triage process` prints the full guide locally. The help footer's list of GitHub-mutating commands is now generated from the registry, fixing the stale "only deps add/remove" claim noted on the ticket. The MCP briefing resolves the same setting so CLI/MCP JSON stay identical.

## Outcomes

The compact guide is 870-odd code points, close to the 900 limit; `compactGuide` throws if a policy change pushes it over, which tests catch. The shared config parser refuses unknown keys, so an unknown key disables config application (with diagnostic) rather than producing only a warning.

## Next Steps

Per-role guides once role-specific guidance is designed; checkpoint-based suppression is out of scope.
