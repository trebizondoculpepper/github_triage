# TypeScript source migration

Owner decision and implementation contract for #91. All maintained first-party application code, scripts and executable examples must use TypeScript. Intentionally chosen ancillary languages, such as Datalog, are allowed where their distinct purpose is documented; they are not a general exemption for handwritten JavaScript. This supersedes previous plain-JavaScript preferences, including those in the MCP research/design. It does not claim the existing JavaScript has already been migrated.

## Rationale and boundary

Explicit types make collector facts, workflow results, injected services and protocol boundaries easier to change safely. JavaScript's direct Node execution avoided a source compilation step, but this project already has TypeScript, Vite+ checks and a release bundle. Prefer stronger maintained source contracts over preserving that convenience.

Published artifacts remain executable JavaScript: Node 20 consumers must not need a compiler, development dependencies or native TypeScript support. TypeScript is erased at runtime; external GitHub/MCP/configuration data still needs validation. Static types do not prove runtime evidence complete or grant workflow permission.

## Expected architectural benefits

Collector facts, workflow interpretations and transport output are different contracts. Explicit interfaces should catch a changed field or callback signature at each consumer before a release. Discriminated unions can require callers to handle complete, incomplete and failed outcomes rather than accidentally treating missing evidence as success. Typed injected GitHub/clock/filesystem services make test doubles and production adapters agree on their boundary.

As CLI and MCP share these services, refactors should produce useful compiler errors at affected callers rather than depend on a model finding every use manually. Strict null/error handling should make assumptions visible during review. These are expected maintainability benefits, not evidence that changing extensions alone eliminates bugs. Measure success through meaningful strict checking coverage and preserved behavior, not a promised speed improvement.

The cost is a supported development execution/build path and an initial typing/refactoring effort. We already ship compiled bundles and use TypeScript tests/tooling, so accepting that cost is preferable to retaining a parallel JSDoc convention. Existing JavaScript is modern ES-module code; its syntax age is not the reason for the decision.

## Language policy and intentional exceptions

TypeScript is mandatory for maintained first-party general-purpose code, including future MCP code and contributor/release helpers. An ancillary language is allowed when it is intentionally part of the architecture: for example, Datalog rules evaluated by the rules experiment, or declarative configuration/query formats consumed by TypeScript services. Record the purpose and validation boundary in the relevant design. Do not rewrite a deliberately selected rules language into TypeScript merely to satisfy an extension count.

This exception does not permit starting another JavaScript implementation or keeping scripts in JavaScript for convenience. Generated JavaScript output and third-party dependencies are expected runtime artifacts, not alternative source-language choices. Historical snapshots and literal fixture content preserve provenance; new maintained executable examples follow the TypeScript rule. CI must distinguish these categories explicitly rather than use an unqualified repository-wide extension ban.

## Migration scope

Convert every maintained first-party `.js`, `.mjs` and `.cjs` source under `src/`, `scripts/` and executable `doc/reports/examples/` to `.ts` or `.mts`, including modules added while this work is open. Current main includes briefing, claims, CLI, compact output, dependencies, GitHub collection, migration, team and update modules; contributor scripts cover package verification, release/version selection and smoke checks. Rebase/recheck this inventory before implementation rather than copy an older worktree.

Tests and Vite configuration already use TypeScript. Keep actual ambient declarations in `.d.ts`; ordinary exported application types may live in `.ts` modules. Replace JSDoc-only parameter/return typing with normal TypeScript declarations while preserving useful explanatory comments. Generated bundles, dependency code, historical source snapshots and literal test fixture payloads are not handwritten maintained modules and must not be rewritten as part of this migration.

TypeScript ESM can correctly use `.js` import specifiers that resolve to `.ts` source and emitted `.js` files. Do not equate those strings with leftover JavaScript source or mechanically change them without checking the selected resolver/build behavior.

## Type checking and execution

Enable `strict: true` and disable `allowJs` for maintained source. Include scripts and executable examples in type checking, using separate configurations where their environment/dependencies differ. All checks are part of the documented contributor validation; a file outside a tsconfig must not quietly escape verification. Preserve ES module output and the existing Node 20 runtime target.

Use concrete fact/result/service types and explicit injected interfaces. Accept `unknown` at untrusted boundaries, validate/narrow it and preserve unknown-evidence semantics. Avoid blanket `any`, `@ts-nocheck`, broad suppressions, or repeated unchecked assertions to get a green build. A narrowly justified escape must be documented and reviewed. Do not combine this migration with architectural redesign merely to make types easier.

Choose a supported development TypeScript execution or precompilation path compatible with existing Vite+ tooling. Document the exact source-checkout commands and update CI to use them. Direct `node src/cli.ts` is not a Node 20 compatibility strategy. Development-only runners must not become consumer runtime requirements. Build/package commands still emit the executable paths expected by npm's bin mapping.

Update contributor/release/package/smoke script entry points and subprocess references together. Release tooling must locate its compiled helper or use the approved contributor execution path consistently. Fixtures and package tests must exercise installed artifacts, not accidentally continue running stale source JavaScript.

## Behavior preservation and coordination

Keep command names/arguments, outputs and schema versions, exit codes, ordering, evidence handling, cache/checkpoint behavior, mutation safeguards and supported Node/OS matrix unchanged. Preserve dependency-free consumers where the emitted bundle permits; adding TypeScript does not require a new runtime framework. Newly planned MCP implementation uses TypeScript as well, independently of whether its transport has shipped.

Check live ownership/open source PRs before the rename. Land current work or coordinate a clear baseline; never overwrite another agent's dirty checkout. Use an isolated branch and preserve Git history with recognizable renames. The implementation can be one cohesive migration PR if reviewable; split only at buildable, type-checked boundaries. No extra feature work or release-policy implementation is hidden in the migration.

## Acceptance and handoff

Run formatting/lint/type checks, the existing test suite, build, smoke tests and exact packed-archive global-install validation. Verify source-development execution and emitted consumer execution separately. Cover supported Node/OS jobs, especially Node 20 running the built CLI, Windows executable/path handling, npm symlinks and helper subprocess paths. Release tests use fake/injected boundaries, never an actual publication or branch promotion.

Verify no maintained handwritten JavaScript module remains in the scoped directories and that every converted file is checked. Record intentionally ancillary-language files and their purpose; enforce the first-party TypeScript boundary without banning those deliberate integrations. Preserve useful archive allowlist assertions while allowing only intentional compiled artifacts. Update package scripts, CI, active architecture/help examples, README and AGENTS instructions to the new commands once implementation ships. Historical research may retain its provenance with a pointer to this superseding decision.

Review/merge this documentation contract first; then mark #91 ready for a focused implementation. Existing JavaScript remains the current implementation until that migration lands. No production code or live release/configuration changes are made by this contract.
