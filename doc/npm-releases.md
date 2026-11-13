# npm distribution and releases

Status: packaging and trusted publishing are implemented, and since #79 **publication is explicit only**: pushes to `main` or `release` never publish. `npm run make-prerelease` publishes a prerelease on `next`; `npm run release` publishes an official version on `latest`. Both dispatch `.github/workflows/publish.yml` with a channel and a full commit SHA, and the workflow validates the request before building anything. Publishing also requires the repository variable `NPM_PUBLISH=true`.

## Purpose and package

Distribute `@trebizondoculpepper/github-triage`, executable `github-triage`, as one global CLI installation serving multiple project checkouts. Project identity remains local. Runtime requires Node 20+ and authenticated GitHub CLI for live queries.

```sh
npm install -g @trebizondoculpepper/github-triage
github-triage --help
```

Use `@next` to opt into prereleases and `@VERSION` to pin a version. Publish the built ESM CLI at `dist/cli.mjs`; allowlist only required runtime artifacts, README and license. Never ship identity files, caches, credentials, agent settings or tests. Consumer installation must not invoke development tooling or install contributor hooks.

## Explicit publication operations

| Request                  | Contributor command       | Source / publication                                                                                                                    |
| ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Build or merge main      | Ordinary CI               | Verify only; no npm publication, release tag, or consumed publication version                                                           |
| Make a prerelease        | `npm run make-prerelease` | Explicit dispatch for a selected origin/main commit; npm `next` only                                                                    |
| Make an official release | `npm run release`         | Fast-forward `release` to selected origin/main commit, then explicit dispatch; stable npm `latest`, matching Git tag and GitHub release |

These are maintainer checkout commands, not installed `github-triage` subcommands. The prerelease command is `npm run make-prerelease`, not `npm run prerelease`: npm automatically runs a script named `pre<name>` before `<name>`, so a `prerelease` script would publish a prerelease every time `npm run release` ran (#79). Both operations are implemented; official release promotion is followed by explicit dispatch rather than push-triggered publication. Both support `-- --help` with their process, prerequisites, target channel, retry behavior and failure recovery. These helpers request publication; they do not report a queued dispatch as a completed npm release.

The publish workflow accepts only `workflow_dispatch`, with required channel choice `next` or `latest` and an expected full source SHA. No `push`, PR, scheduled, or CI-completion event publishes. Main and release branch pushes alone cannot publish. Changing `NPM_PUBLISH` remains setup control, not a release request.

The helper fetches origin/main and resolves a full SHA once. Prerelease dispatch uses the main ref; official release first validates/fast-forwards release, then dispatches on that ref. The workflow checks its event/ref/channel combination, requires its source SHA to match the expected SHA and verifies ancestry on origin/main. If the ref moved between selection and dispatch, fail before publishing and explain how to make a new explicit request; never silently publish a different commit. A dirty local checkout is not the source of an artifact.

An official promotion must not force-push or rewrite release history. Its push does not itself publish. If promotion succeeds but dispatch fails, report that partial result and give a retry that dispatches the same promoted SHA. Retrying publication must not re-resolve main and accidentally select new work.

## Channels, versions and idempotency

The first official stable release is **0.1.0**. After that, official releases increment minor and reset patch: `0.2.0`, `0.3.0`; no automatic major bump. Explicit prerelease publications advance the patch line with an explicit suffix: after stable `0.1.0`, `0.1.1-next.1`, then `0.1.2-next.1`. Before initial stable, use `0.0.x-next.1`. Unpublished main commits consume no version.

Derive versions from actual publication history, using each artifact's source `gitHead`; do not commit version churn to main. A retry for the same SHA/channel finds its existing publication rather than assigning another version. The same commit may separately receive its prerelease and official stable publication. Never reuse an immutable npm version. Existing registry-lag prerelease collision handling stays bounded; stable collisions require inspection, not an unrequested minor bump.

Serialize requests within each channel without cancelling an in-flight publication. The implemented workflow uses separate next/latest queues because their dist-tags and version forms are distinct; one channel must not cancel the other. Recheck source/channel freshness and publication history inside the serialized operation. Reject an older request if it would move a channel behind a known newer published source; report insufficient or conflicting evidence instead of guessing. GitHub may replace a pending concurrency run: helpers must return the run link and distinguish queued, cancelled, failed and completed, rather than promise that every dispatch publishes.

Prerelease changes only `next`; official publication changes only `latest`. A retry that finds an existing version repairs only missing matching completion steps and never rolls a channel backwards. Do not delete packages, rewrite old artifacts, or alter existing dist-tags as incidental cleanup. Any correction of historic `latest` pointing at a prerelease is a separate explicit operation.

## Verification and failure reporting

Before either channel publishes, verify the selected SHA with current required checks, formatting/lint/type checks, credential-free tests and build. Run `npm pack`, inspect archive contents, install that exact archive globally into an isolated temporary npm prefix, and exercise help, invalid arguments and offline fixtures. Source execution alone is insufficient.

Keep trusted publishing from the designated `publish.yml` and npm provenance. GitHub/npm permissions govern publishing; no new triage-specific authority model. PR jobs have no publication credentials. A disabled publish toggle must report publication disabled, not successful release.

Record source SHA, package/version, channel, workflow run and verification evidence. npm publication, tag creation and GitHub release creation are separate steps. Report partial success accurately. Retry missing completion steps for the same version/SHA without republishing or changing source. Reject an existing tag/release pointing elsewhere; do not silently overwrite it.

Credential-free verification must cover:

- Main and release pushes cannot reach publication; explicit dispatch is required.
- Invalid channel/ref/SHA or a ref race fails before publication.
- Prerelease changes only next; official stable changes latest and produces matching release metadata.
- Duplicate dispatch, registry lag, cross-channel ordering, pending cancellation and delayed older requests preserve immutable history.
- Publish success followed by metadata failure recovers the same artifact; disabled toggle and missing permissions are actionable failures.
- Packaged global installation works without consumer hooks or development dependencies.

No real official release is needed to test the workflow. Use injected command/registry responses and inspect event guards.

## Owner setup and delivery

Existing package authorization and trusted publisher remain in place. Confirm npm scope ownership and the GitHub Actions publisher for `trebizondoculpepper/github_triage`, workflow `publish.yml`, when setup is needed. `NPM_PUBLISH=true` permits an explicitly requested publication; it does not cause one on main pushes. This contract does not change any live variable, permission, branch, tag or package.

The explicit-only implementation merged in #90 for #79. Helpers, workflow and credential-free tests cover the dispatch path. Role views, MCP, update notices and wake-up adapters remain independent. Source/helper changes still need normal PR verification; do not publish a package merely to validate documentation.
