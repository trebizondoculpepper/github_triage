# Extract GitHub Triage into its own project

| Time           | Branch | Source                                      | Task                        |
| -------------- | ------ | ------------------------------------------- | --------------------------- |
| 2026-11-12 UTC | main   | poker_blocks 7579093 plus native-read draft | Standalone Vite+ extraction |

The owner requested moving the triage project into `/Users/salimfadhley/workspace/github_triage` so another LLM can continue it, then asked for GitHub CI tickets and an open-source project. The target already had an empty Git repository and the correct public GitHub remote.

Copied the stable compact CLI and the interrupted native-dependency draft into `src/`, with inherited contracts, an explicit handoff, MIT licensing and contributor guidance. Added standalone Vite+ checks/tests/packaging/hooks and a small CI baseline. Transferred six open tooling issues and the closed dependency parent with history intact. Restored repository-specific labels and verified native dependency links survived. Added CI portability and safe-required-PR-gate tickets.

Source execution, the 22 existing tests and packaging are functional. The native-read draft still needs its dedicated acceptance suite and review; it is explicitly not represented as a completed feature. No credentials or private live snapshots moved with the project. The new LLM should start with HANDOFF.md and issue #4, or independent CI tickets #8/#9.
