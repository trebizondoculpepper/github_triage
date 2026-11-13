# GitHub Triage

[![CI](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/trebizondoculpepper/github_triage/actions/workflows/ci.yml)

Evidence-linked GitHub issue and pull request briefings for coding agents. A standalone CLI using your existing authenticated `gh` session, with Vite+ for checks, tests and builds. Maintained source is moving to strict TypeScript under [#91](https://github.com/trebizondoculpepper/github_triage/issues/91); existing runtime modules remain JavaScript until that migration lands.

## Why this tool exists

Repeatedly searching issues, PRs, review feedback and dependencies costs agents time and tokens. GitHub Triage collects the relevant evidence into a compact briefing with source links and detail on demand. It helps implementers find the next useful action, and helps a designer answer “what changed, and what needs the owner’s attention?” Dedicated role views remain planned, not shipped.

## Get started

Requires Node.js 26+ (the current LTS) and an authenticated [GitHub CLI](https://cli.github.com/).

Install once globally, then use it from any project checkout:

```sh
npm install -g @trebizondoculpepper/github-triage
github-triage --help
github-triage --repo owner/repository
github-triage --repo owner/repository --issue 42
github-triage --repo owner/repository --agent inbox-name
github-triage deps 42 --repo owner/repository --tree
github-triage team --repo owner/repository
github-triage ticket-doctor --repo owner/repository
```

Without `--repo`, GitHub CLI resolves the repository from the current working directory. Use `--repo` to inspect another project. Source-checkout setup is under Development below; per-project npm installation is not needed for consumers. Commands described here are on main; use your installed version's `--help` to confirm availability before upgrading.

The briefing and `deps N` are read-only. They do not claim, label, merge or close tickets. Suggestions, closed dependencies and question candidates require human/agent inspection; they are not approval. `deps add`, `deps remove`, `claim` and `needs-human` are the only commands that change GitHub. Each reads live state first, refuses with a stable error ID and recovery commands when a prerequisite fails, posts one explanatory comment, and supports `--dry-run`. `deps add`/`remove` edit native blocked-by relationships ([dependency design](doc/issue-dependencies.md)); `claim N --agent NAME` takes one eligible ticket (one active claim per agent, never another agent's); `needs-human N --agent NAME --designer NAME --why ... --question ...` records questions for a designer and marks the ticket decision-needed ([workflow contract](doc/design/workflow.md)). `deps migrate --plan` writes a read-only report of how `Depends on` text and `blocked:work` labels map to native dependencies; automatic apply is deferred (#48). Releasing and handoff (`release`, #62) are specified but not implemented yet.

## Install once, use across projects

One global executable serves multiple checkouts; persistent project identity stays local.

Use `@next` to opt into development prereleases, or `@VERSION` to pin a release. One executable serves multiple checkouts; project identity/configuration stays project-specific. The first registry publications are prereleases; see the [release contract](doc/npm-releases.md) for channels and official-release policy. Running the source checkout remains useful for development.

Publication is explicit: maintainers use `npm run make-prerelease` for `next` or `npm run release` for `latest` from a contributor checkout. Main/release pushes and ordinary CI do not publish. The prerelease command is deliberately named `make-prerelease` to avoid npm’s automatic pre-script behavior. See the [release contract](doc/npm-releases.md) for prerequisites and source-pinned retries; installing or building is not a release request.

See the [usage guide](doc/usage.md) for ticket intake, dependencies, catch-up, cache/offline behavior and exit codes. The [design handoff](doc/design/README.md) distinguishes pending role views, release/handoff, local configuration doctor, MCP and cached update checks from implemented commands. Ticket Doctor scans project tickets; the planned local `doctor` checks configuration.

## Supported runtimes

The CLI and its development tooling target the current Node.js LTS, which is Node.js 26 as of 2026-11-13 ([runtime policy](doc/design/runtime.md)); `package.json` `engines` declares `>=26`. A global npm install or `npx` uses whatever Node is already installed and does not upgrade it, so upgrade Node first if `node --version` reports an older major. The minimum is not a claim that later majors have been tested; the baseline is updated deliberately when the LTS changes. CI tests Node.js 26 on Ubuntu, macOS and Windows, using `npm ci` and the committed lockfile. Every job runs the Vite+ checks, the test suite, the build, the smoke tests and `npm run package-test`, which packs the real npm archive, checks its contents, installs it into a clean consumer and runs the installed command. Line endings are LF on every platform (`.gitattributes`). One test fakes `gh` with a POSIX shell script and is skipped on Windows. On Windows, `npm run smoke` covers the same ground: it makes `gh` unreachable to exercise the failure path and uses offline fixtures for the success and incomplete-evidence exit codes.

## Development

```sh
npm ci
npm run triage -- --repo owner/repository
npm run check
npm test
npm run build
node dist/cli.mjs --help
npm run smoke    # credential-free exit-code smoke test of dist/cli.mjs
```

Vite+ owns formatting, linting, type checking, testing, packaging and staged-file hooks. Runtime uses only Node built-ins and `gh`: no SDK, token handling or frontend. Source is strict TypeScript; `npm run triage` runs it through the `tsx` devDependency for consistent module resolution, while consumers run the built `dist/cli.mjs`. Tests use fixtures and injected boundaries, not live GitHub credentials.

Start with [HANDOFF.md](HANDOFF.md) for transferred issues, provenance, verified behavior and unfinished work. The [CLI contract](doc/github-triage-cli.md) and [dependency design](doc/issue-dependencies.md) describe the design inherited from the original repository. [npm releases](doc/npm-releases.md) records release behavior and owner setup. [CONTRIBUTING.md](CONTRIBUTING.md) covers contributions.

## License

[MIT](LICENSE).
