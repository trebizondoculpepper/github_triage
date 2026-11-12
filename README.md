# GitHub Triage

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

## Development

```sh
npm run check
npm test
npm run build
node dist/cli.mjs --help
```

Vite+ owns formatting, linting, type checking, testing, packaging and staged-file hooks. Runtime uses only Node built-ins and `gh`: no SDK, token handling, frontend or build step is needed to run the source CLI. Tests use fixtures and injected boundaries, not live GitHub credentials.

Start with [HANDOFF.md](HANDOFF.md) for transferred issues, provenance, verified behavior and unfinished work. The [CLI contract](doc/github-triage-cli.md) and [dependency design](doc/issue-dependencies.md) describe the design inherited from the original repository. [CONTRIBUTING.md](CONTRIBUTING.md) covers contributions.

## License

[MIT](LICENSE).
