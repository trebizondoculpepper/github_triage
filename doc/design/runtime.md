# Recent Node runtime policy

Owner decision, 2026-11-13; implementation #108. Preserving older Node compatibility is not a project requirement. Use **Node 26 or later** as the selected baseline, with the latest maintained patch of the Node 26 LTS line recommended for development and use. This supersedes earlier Node 20 preservation requirements in the migration, MCP and packaging designs.

## Why this baseline

The tool serves agents and maintainers who can install a recent runtime. Supporting old runtimes should not constrain TypeScript architecture or add compatibility work without a concrete need. Node's [26.13.0 release announcement](https://nodejs.org/en/blog/release/v26.13.0), checked 2026-11-13, identifies Node 26 as an LTS line. Selecting its major gives the project one explicit recent baseline rather than an undefined promise to run on every Node version.

`npx`/npm execution and a global npm installation use the available Node runtime. They do not automatically select or upgrade it to satisfy the package. Document the minimum and an actionable upgrade requirement; never claim an arbitrary installed Node version works simply because the command is run through npx. No tool operation should silently change the user's global Node installation.

## Implementation and checks

Set the package engine floor to `>=26`, align the build/runtime target where appropriate, and run the supported OS matrix on Node 26. Test the built executable and exact globally installed archive on Ubuntu, macOS and Windows. Additional recent-version coverage may be added when useful; Node 20/22/24 compatibility jobs are no longer required. Do not preserve shims or extra build paths solely for those older versions.

Use the same recent baseline for contributor tooling and publication jobs where practical. Preserve reproducible dependencies and current-head verification. A minimum major is not a claim that every future major has been tested. Publish new requirements in the package and current user documentation together; until #108 implementation ships, existing package engines and CI still describe the old implementation.

This decision does not require abandoning the bundle or rewriting source execution. TypeScript checking remains mandatory even if the selected Node can execute erasable TypeScript syntax. A development runner may remain useful for module resolution or workflow consistency; compiled JavaScript can remain the installed artifact. Decide those mechanics on evidence and simplicity rather than on a retired old-runtime constraint.

## Relationship to the urgent migration

#91 remains urgent. Its TypeScript language boundary, strict checking and behavior preservation still apply on the selected supported runtime. Older-Node compatibility is explicitly not acceptance for that work. Coordinate the small engine/CI changes with the migration if convenient, or deliver #108 independently; do not delay the port for an unnecessary runner/bundle redesign.

No runtime, CI, engine field, global installation or npm publication is changed by this documentation PR. Implementation checks must demonstrate supported-runtime behavior without publishing a real version or installing a new global Node as a test. Existing CLI schemas, exit semantics, mutation safeguards and explicit release authorization remain unchanged.
