# Repository settings: the contribution gate (#9)

Configured on 2026-11-12. This records the exact settings so that they can be checked or restored; change them only through a reviewed update to this page.

## CI is safe for forks

- `.github/workflows/ci.yml` runs on `pull_request` (never `pull_request_target`) with `permissions: contents: read` and no secrets, so a fork's code runs with a read-only token and no credentials.
- Its matrix jobs (`test (os, node)`) run the Vite+ checks, tests, build, smoke tests and the installed-archive package test. The `verify` job passes only when every matrix job passed, and is the single check to require.
- `.github/workflows/publish.yml` runs only on pushes to `main` and `release`, never for pull requests.

## `main` ruleset

Ruleset **"main: pull requests and verify"** (id 27166105), enforcement **active**, target the default branch, **no bypass actors**:

| Rule                                  | Setting                                                                |
| ------------------------------------- | ---------------------------------------------------------------------- |
| Require a pull request before merging | on; **0** required approvals                                           |
| Require status checks to pass         | `verify` (GitHub Actions); "require branches to be up to date" **off** |
| Block force pushes                    | on                                                                     |
| Restrict deletions                    | on                                                                     |

Why these values:

- **0 approvals.** The owner and every agent act through the same GitHub account, and GitHub does not let a pull request's author approve it, so a required approval would block every merge. Review happens through Codex, CodeRabbit and the reviewing agent; `verify` is the enforced gate.
- **Branches need not be up to date.** `verify` must pass on the pull request's current head; requiring a rebase after every merge would add churn without a corresponding check. Conflicts still block merging.
- **No bypass.** Nobody, including administrators, merges around `verify`.

The `release` branch is not covered: `npm run release` fast-forwards it to a commit already on `main`, and the Publish workflow refuses a release commit that is not on `main`.

## Plan restrictions

The repository is public, where rulesets with required status checks are available on the free plan. None of the settings above needed a paid feature.
