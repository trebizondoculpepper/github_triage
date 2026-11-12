# GitHub Triage

[![CI](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml)

Evidence-linked GitHub issue and pull request briefings for coding agents. A standalone JavaScript CLI using your existing authenticated `gh` session, with Vite+ for checks, tests and builds.

## Get started

Requires Node.js 20+ and an authenticated [GitHub CLI](https://cli.github.com/).

```sh
npm install
npm run triage -- --repo owner/repository
npm run --silent triage -- --repo owner/repository --json
npm run triage -- --repo owner/repository --issue 42
npm run triage -- --repo owner/repository --agent inbox-name
npm run triage -- deps 42 --repo owner/repository --tree
```

Without `--repo`, `gh repo view` resolves the repository from the **current working directory**. From this checkout that means `github_triage`, not `poker_blocks`. To inspect a different checkout while keeping its current-directory resolution:

```sh
node /path/to/github_triage/src/cli.js --json
```

The briefing and current dependency commands are read-only. They do not claim, label, merge or close tickets. Suggestions, closed dependencies and question candidates require human/agent inspection; they are not approval. Future mutation commands are separately specified and not implemented yet.

## Supported runtimes

The CLI runs on Node.js 20 or later. CI tests it with Node.js 20, 22 and 24 on Ubuntu, macOS and Windows, using `npm ci` and the committed lockfile. Development tooling (Vite+ checks, tests and build) needs Node.js 22 or later, so the Node 20 jobs run the tooling on Node 22 and then smoke-test the built and source CLI on Node 20. Every job runs the Vite+ checks, the test suite, the build and the smoke tests. Line endings are LF on every platform (`.gitattributes`). One test fakes `gh` with a POSIX shell script and is skipped on Windows. On Windows, `npm run smoke` covers the same ground: it makes `gh` unreachable to exercise the failure path and uses offline fixtures for the success and incomplete-evidence exit codes.

## Development

```sh
npm run check
npm test
npm run build
node dist/cli.mjs --help
npm run smoke    # credential-free exit-code smoke test of dist/cli.mjs
```

Vite+ owns formatting, linting, type checking, testing, packaging and staged-file hooks. Runtime uses only Node built-ins and `gh`: no SDK, token handling, frontend or build step is needed to run the source CLI. Tests use fixtures and injected boundaries, not live GitHub credentials.

Start with [HANDOFF.md](HANDOFF.md) for transferred issues, provenance, verified behavior and unfinished work. The [CLI contract](doc/github-triage-cli.md) and [dependency design](doc/issue-dependencies.md) describe the design inherited from the original repository. [npm releases](doc/npm-releases.md) records the agreed packaging and release design, not yet implemented. [CONTRIBUTING.md](CONTRIBUTING.md) covers contributions.

## License

[MIT](LICENSE).
