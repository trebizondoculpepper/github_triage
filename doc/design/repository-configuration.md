# Repository configuration through the tool

## Why

The owner wants an opinionated workflow whose configuration semantics live in program code rather than an agent's memory. A supported command boundary can validate values, explain defaults and migrate stored schemas consistently. Agents must use that boundary instead of directly editing configuration files.

## Scope and commands

Repository is the only supported scope and is implicit. The merged commands are `config get KEY`, `config set KEY VALUE`, `config list` and `config help`. Per-agent identity keys/selectors are an extension defined in identity.md and are not installed by this documentation. Global/machine scopes, precedence between scopes and arbitrary user-defined keys are deferred. Unknown scopes/keys are refused with actionable guidance.

`get` returns the effective typed value and whether it comes from a default or an explicit setting. `list` includes every explicitly configured setting and distinguishes effective defaults so a default-enabled feature is visible. `set` validates a registered key/type before writing; repeated equal writes are harmless. Help explains the purpose, defaults, valid values and recovery commands. Text and versioned JSON output share semantics; no JSON result is polluted by notices. Missing repository selection never silently targets another checkout.

## Storage and migration contract

Use a repository-owned, versioned `.github/triage.json` file for non-secret shared settings. It is suitable for normal Git review; configuration changes are not automatically committed. This file does not store credentials, per-agent identity or disposable caches. A remote `--repo` alone is not permission to write an unrelated local checkout: resolve/verify the target root and repository before mutation.

A shared TypeScript configuration service owns registered keys, typed validation, defaults, schema versioning, migrations and filesystem access. CLI, setup and diagnostics call that service. Read-only operations never rewrite or migrate files. Writes validate and migrate supported older versions in memory, preserve unrelated supported values, and replace the file atomically after checking for intervening edits. Refuse malformed, unsupported-future or incompatible data without destructive rewriting; expose exact recovery guidance. Test missing/current/old/future versions and failed/concurrent writes through injected filesystem boundaries. No configuration framework or global daemon is required.

## Initial complexity settings

`complexity.enabled` is Boolean and defaults to true, including when the file/key is absent. `complexity.fieldId` is an explicitly selected native GitHub field identifier, initially unset. Enabled does not mean configured: absent mapping is a setup diagnostic, never permission to create a shared GitHub field. `config set complexity.enabled false` is the proposed opt-out. An empty ticket estimate is not a configuration fault.

Disabling complexity suppresses its estimation queue and complexity-field diagnostics; retain existing mapping and remote estimates without deleting them. Existing unrelated triage commands remain usable when setup is incomplete. A missing field mapping must not crash ordinary briefings.

## Delivery boundary

Configuration foundation and CLI commands are separate focused slices. Complexity setup, native API verification, diagnostics and estimates build on them. Architecture review must land before runtime implementation. The configuration epic tracks these slices without making parent completion a prerequisite for children. No live configuration is changed by this design.

## Confirmed local identity and TOML direction

Per-agent config reuses this service/command layer but routes identity.name and identity.triage_role to the selected entry in root-level `agent-inbox.toml`, which remains ignored and non-versioned. See [identity.md](identity.md). No external service is needed. The owner prefers TOML for all project-owned configuration; the separate [format contract](configuration-formats.md) targets `.github/triage.toml` for shared policy while documenting the existing JSON runtime and safe bounded conversion. That later conversion must not block identity.
