# Contributing

Open an issue describing a reproducible problem or scoped feature before substantial changes. See [HANDOFF.md](HANDOFF.md) for the initial backlog and the [agent guide](AGENTS.md) for architecture and project conventions.

Use Node 22+ for development (the Vite+ tooling needs it; the CLI itself runs on Node 20+), npm and Vite+. Run `npm install`, then `npm run check`, `npm test` and `npm run build`. The pre-commit hook checks staged files. Tests should run without GitHub credentials; reproduce live issues using your own `gh` session without committing tokens or full private snapshots.

Submit a focused pull request using the template: link its issue and explain behavior, validation and limitations. Every change to `main` goes through a pull request, and the `verify` check must pass on its current head before it can merge; pull requests from forks run the same credential-free checks with read-only permissions ([repository settings](doc/repository-settings.md)). Architectural contract changes go through a docs PR first. Contributions are under the project's MIT license. Releases are described in [npm releases](doc/npm-releases.md).

The owner has requested a process mirror from poker_blocks. The proposed [ticket-to-merge process](doc/process.md) and [design/implementation responsibilities](doc/design-implementation.md) are being considered in [#12](https://github.com/trebizondoculpepper/github_triage/issues/12). Until adoption is reviewed, the contribution requirements above remain current.
