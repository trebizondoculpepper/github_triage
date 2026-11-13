# GitHub Triage

[![CI](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml)

Evidence-linked GitHub issue and pull request briefings for coding agents. A standalone JavaScript CLI using your existing authenticated `gh` session, with Vite+ for checks, tests and builds.

## Why this tool exists

Repeatedly searching issues, PRs, review feedback and dependencies costs agents time and tokens. GitHub Triage collects the relevant evidence into a compact briefing with source links and detail on demand. It helps implementers find the next useful action, and helps a designer answer “what changed, and what needs the owner’s attention?” Dedicated role views remain planned, not shipped.

## Get started

Requires Node.js 20+ and an authenticated [GitHub CLI](https://cli.github.com/).

```sh
npm install
npm run triage -- --repo owner/repository
npm run --silent triage -- --repo owner/repository --json
npm run triage -- --repo owner/repository --issue 42
npm run triage -- --repo owner/repository --agent inbox-name
npm run triage -- deps 42 --repo owner/repository --tree
npm run triage -- team --repo owner/repository    # each agent's claims, linked PRs, activity, warnings
```

Without `--repo`, `gh repo view` resolves the repository from the **current working directory**. From this checkout that means `github_triage`, not `poker_blocks`. To inspect a different checkout while keeping its current-directory resolution:

```sh
node /path/to/github_triage/src/cli.js --json
```

The briefing and `deps N` are read-only. They do not claim, label, merge or close tickets. Suggestions, closed dependencies and question candidates require human/agent inspection; they are not approval. `deps add` and `deps remove` are the only commands that change GitHub: they edit native blocked-by relationships after live validation, post one explanatory comment, and support `--dry-run` ([dependency design](doc/issue-dependencies.md)). `deps migrate --plan` writes a read-only report of how `Depends on` text and `blocked:work` labels map to native dependencies; automatic apply is deferred (#48). Claiming and flagging are specified separately and not implemented yet.

## Install once, use across projects

Recommend a global installation of this standalone CLI rather than a dev dependency in each project:

```sh
npm install -g @trebizondoculpepper/github-triage
github-triage --help
github-triage --repo owner/repository
```

Use `@next` to opt into development prereleases, or `@VERSION` to pin a release. One executable serves multiple checkouts; project identity/configuration stays project-specific. The first registry publications are prereleases; see the [release contract](doc/npm-releases.md) for channels and official-release policy. Running the source checkout remains useful for development.

See the [usage guide](doc/usage.md) for ticket intake, dependencies, catch-up, cache/offline behavior and exit codes. The [design handoff](doc/design/README.md) describes planned role, workflow, doctor, MCP and update features; it does not claim those commands already exist.

## Supported runtimes

The CLI runs on Node.js 20 or later. CI tests it with Node.js 20, 22 and 24 on Ubuntu, macOS and Windows, using `npm ci` and the committed lockfile. Development tooling (Vite+ checks, tests and build) needs Node.js 22 or later, so the Node 20 jobs run the tooling on Node 22 and then smoke-test the built and source CLI on Node 20. Every job runs the Vite+ checks, the test suite, the build, the smoke tests and `npm run package-test`, which packs the real npm archive, checks its contents, installs it into a clean consumer and runs the installed command. Line endings are LF on every platform (`.gitattributes`). One test fakes `gh` with a POSIX shell script and is skipped on Windows. On Windows, `npm run smoke` covers the same ground: it makes `gh` unreachable to exercise the failure path and uses offline fixtures for the success and incomplete-evidence exit codes.

## Development

```sh
npm run check
npm test
npm run build
node dist/cli.mjs --help
npm run smoke    # credential-free exit-code smoke test of dist/cli.mjs
```

Vite+ owns formatting, linting, type checking, testing, packaging and staged-file hooks. Runtime uses only Node built-ins and `gh`: no SDK, token handling, frontend or build step is needed to run the source CLI. Tests use fixtures and injected boundaries, not live GitHub credentials.

Start with [HANDOFF.md](HANDOFF.md) for transferred issues, provenance, verified behavior and unfinished work. The [CLI contract](doc/github-triage-cli.md) and [dependency design](doc/issue-dependencies.md) describe the design inherited from the original repository. [npm releases](doc/npm-releases.md) records release behavior and owner setup. [CONTRIBUTING.md](CONTRIBUTING.md) covers contributions.

## License

[MIT](LICENSE).
