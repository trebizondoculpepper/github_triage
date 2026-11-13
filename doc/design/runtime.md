# Recent Node runtime policy

Owner decision, 2026-11-13; implementation #108. Preserving older Node compatibility is not a project requirement. Target the **current Node.js LTS release**, with a maintained patch recommended for development and use. The policy is not “always require the newest major” or “use bleeding-edge Node.” This supersedes earlier Node 20 preservation requirements in the migration, MCP and packaging designs.

## Why this baseline

The tool serves agents and maintainers who can install a recent runtime. Supporting old runtimes should not constrain TypeScript architecture or add compatibility work without a concrete need. Node's [26.13.0 release announcement](https://nodejs.org/en/blog/release/v26.13.0), checked 2026-11-13, identifies Node 26 as an LTS line. That is the current concrete LTS choice at this review date, not a permanent architectural requirement for major 26. When LTS changes, review and update the declared package/CI baseline deliberately; do not silently change the supported runtime on each invocation.

`npx`/npm execution and a global npm installation use the available Node runtime. They do not automatically select or upgrade it to satisfy the package. Document the minimum and an actionable upgrade requirement; never claim an arbitrary installed Node version works simply because the command is run through npx. No tool operation should silently change the user's global Node installation.

## Implementation and checks

Implemented in #108: `engines.node` is `>=26`, CI tests Node 26 on Ubuntu and Windows as required jobs, plus a non-blocking FreeBSD trial job in a VM (owner decision 2026-11-13; outside `verify`, removable if it proves problematic) (macOS was dropped by owner decision on 2026-11-13: it is expected to match Linux, and runs only when explicitly requested), and the publish job uses Node 26. Select and document a concrete engine floor based on the current LTS, align the build/runtime target where appropriate, and run the supported OS matrix on that LTS. Test the built executable and exact globally installed archive on Ubuntu and Windows; macOS is covered by Linux unless explicitly requested. Additional supported-LTS coverage may be retained when useful, but a broad old-version matrix is not required. Remove compatibility jobs or shims that exist only for particularly old releases; do not discard a supported LTS solely because it is not the newest major.

Use the same recent baseline for contributor tooling and publication jobs where practical. Preserve reproducible dependencies and current-head verification. A minimum major is not a claim that every future major has been tested. Publish new requirements in the package and current user documentation together; package engines, CI and user documentation now state the Node 26 baseline together.

This decision does not require abandoning the bundle or rewriting source execution. TypeScript checking remains mandatory even if the selected Node can execute erasable TypeScript syntax. A development runner may remain useful for module resolution or workflow consistency; compiled JavaScript can remain the installed artifact. Decide those mechanics on evidence and simplicity rather than on a retired old-runtime constraint.

## Relationship to the urgent migration

#91 remains urgent. Its TypeScript language boundary, strict checking and behavior preservation still apply on the selected supported runtime. Older-Node compatibility is explicitly not acceptance for that work. Coordinate the small engine/CI changes with the migration if convenient, or deliver #108 independently; do not delay the port for an unnecessary runner/bundle redesign.

No runtime, CI, engine field, global installation or npm publication is changed by this documentation PR. Implementation checks must demonstrate supported-runtime behavior without publishing a real version or installing a new global Node as a test. Existing CLI schemas, exit semantics, mutation safeguards and explicit release authorization remain unchanged.
