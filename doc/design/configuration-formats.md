# TOML-first project configuration

## Why and scope

Owner preference: configuration owned by this project should use TOML wherever possible because it is readable, editable and easy to work with. This is a format preference, not authorization for global/machine configuration scope. Supported configuration scope remains repository-only.

Use `agent-inbox.toml` at the Git working-tree root for local, ignored per-agent identity. Prefer versioned `.github/triage.toml` for shared repository settings, preserving the registered keys/defaults and command semantics. Agents use `config` commands; human-readable syntax does not mean an LLM should bypass validation/migrations by editing files.

## Existing storage and conversion

The current shared settings implementation uses `.github/triage.json`; converting it is a separate follow-up, not a prerequisite for urgent TOML identity work. Do not silently switch paths and discard existing values. The conversion ticket must provide one bounded config-mediated conversion preserving the existing schema/default behavior and stored values; exact command syntax is an engineering choice to document before release. Read-only get/list/doctor never rewrite or convert files. Both authoritative files present is an explicit conflict, not a hidden precedence rule. Preserve the old file until conversion is verified; report partial results/recovery and do not automatically commit changes. No generic multi-format configuration framework or permanent dual authoritative backend is needed.

Delivered conversion syntax (#160): `github-triage config convert [--prefer toml|json] [--json] [--repo owner/name]`. Until it runs, the JSON file stays readable and `config set` updates it in place; a repository with neither file starts on TOML. Convert writes and verifies TOML before removing the JSON. Both files present is a `duplicate-config` refusal; convert removes a JSON file whose settings the TOML file already holds, and `--prefer` names the file to keep when they disagree. A failure after the TOML write is reported as `partial-conversion` with the exact command that finishes or reverses it. See [usage](../usage.md).

Coordinate with labels-only cleanup so retired `complexity.fieldId` is not reintroduced. Preserve remaining registered values such as `complexity.enabled` and `processGuide`; identity stays local rather than becoming shared repository policy.

## Necessary exceptions

Keep required ecosystem formats such as npm's `package.json`/lockfile and GitHub Actions workflow YAML; converting those would break their consumers. JSON CLI/MCP results, protocol framing, caches, fixtures and reports are data artifacts, not project settings that must be changed merely because they use JSON. Do not convert third-party files or unrelated host configuration. Record future exceptions with the consumer/reason.

## Shared implementation

Use the shared TOML parser/writer boundary from the identity work, with typed registry validation, safe unknown-key handling, atomic writes and explicit errors. Library choice is delegated to the implementer against the [documented recommendation](../reports/toml-library-choice.md). Do not broaden credentials, install a service or add a new machine/global settings hierarchy.
