# npm distribution and releases

Status: agreed release design, pending a reviewed documentation PR and implementation. Nothing here claims publication is configured or complete. Tracked in [#17](https://github.com/trebizondoculpepper/github_triage/issues/17).

## Purpose and package

Distribute the CLI as `@trebizondoculpepper/github-triage` so projects can install a reproducible version without referencing a sibling source checkout. Confirm the exact npm account and scope ownership during authenticated setup. Keep the executable name `github-triage`. The first official release is **0.1.0**.

Publish the built ESM CLI, with the package bin pointing to `dist/cli.mjs`. Explicitly allowlist the runtime artifact, README, and license. Include any additional runtime files only if the bundle needs them. Do not publish project identity files, caches, credentials, agent settings, or tests. Consumer installation must not invoke development tooling or install contributor Git hooks. Preserve the supported CLI runtime; build tooling can use its own supported Node version.

Consumers install official releases with:

```sh
npm install --save-dev @trebizondoculpepper/github-triage
npx github-triage --help
```

An installed, authenticated GitHub CLI remains a runtime prerequisite for live queries. This installation example describes the target release, not a package already available.

## Channels and versions

- Successful verified main builds publish unique prereleases under npm `next`.
- Each new main build advances the patch component, retaining an explicit prerelease suffix. For example: stable `0.1.0`, then `0.1.1-next.1`, then `0.1.2-next.1`.
- Official releases occur only at the owner’s explicit request, by promoting an origin/main commit to the `release` branch. They publish under `latest` and create the matching Git tag and GitHub release.
- After the initial `0.1.0`, an official release increments minor and resets patch: `0.2.0`, then `0.3.0`. No automatic major bump.
- Before the first official release, use prereleases on the `0.0.x-next.1` line so initial stable `0.1.0` follows them in semantic version order.

The prerelease counter comes from successful publication history, not edits committed back to main. A rerun for the same commit must recognize an already published artifact rather than assign another version. Serialize publication and prevent a delayed main run from moving `next` backwards. Main builds never move `latest`. Pull-request jobs never publish.

Consumers opt into development builds with `npm install --save-dev @trebizondoculpepper/github-triage@next`; lockfiles record the resolved version.

## Verification and publication

Before either channel publishes, run formatting/lint/type checks, credential-free tests, and the build. Run `npm pack`, inspect the archive contents, install that exact archive into a clean temporary consumer, and exercise the installed executable: help, invalid arguments, and offline fixtures. Verify npm’s linked executable behavior (#11); direct source execution alone is insufficient.

Use npm trusted publishing from the designated GitHub Actions workflow. Bootstrap the initial npm package/account authorization separately if required by npm; confirm current prerequisites against official documentation. GitHub and npm permissions govern publication, not a new triage-specific authority model. No credentials are committed or passed to untrusted PR jobs.

Record the published version, source commit, channel, package identity, and verification evidence. npm publication and GitHub release creation are separate steps: report partial failures and resume without attempting to replace an immutable npm version or deleting published packages as routine retry behavior.

## Implementation and owner setup

Implemented in #17:

- `package.json`: name `@trebizondoculpepper/github-triage`, bin `github-triage` → `dist/cli.mjs`, `files` allowlist (npm adds `package.json`, README and LICENSE), `prepack` builds, `publishConfig.access: public`. No install scripts reach consumers.
- `npm run package-test` (`scripts/package-test.mjs`), run in every CI job and before publishing: packs the archive, asserts its exact contents, installs it into a clean consumer, and runs the installed bin (help, invalid arguments, offline smoke checks).
- `scripts/release-version.mjs`: chooses the version from the registry's publication history and each version's `gitHead`, following "Channels and versions"; a commit already published on a channel is reported, not republished.
- `.github/workflows/publish.yml`: on pushes to `main` (channel `next`) and `release` (channel `latest`), queued per branch without cancelling a run in progress (so a `main` push never cancels a pending release), with a manual re-run for the `release` branch. It verifies first, skips a `main` run that is no longer `main`'s head (so `next` never moves backwards), requires a release commit to be on `main`, publishes with npm trusted publishing and provenance, and for `latest` creates the `vX.Y.Z` tag and GitHub release (also on a retry that finds the version already published).
- `npm run release` (`scripts/release.mjs`): the owner's explicit request, fast-forwarding `release` to `origin/main`; if `release` already matches, it re-requests the Publish run for `release` (safe: an already-published commit is not republished). Nothing publishes from a working tree.

**The publish workflow is inert until the owner enables it.** To enable publication, check each step against npm's current trusted-publishing documentation:

1. Confirm the npm account `trebizondoculpepper` owns the `@trebizondoculpepper` scope.
2. Configure a trusted publisher for the package: GitHub Actions, repository `trebizondoculpepper/github_triage`, workflow `publish.yml`. If npm requires the package to exist before a trusted publisher can be added, bootstrap the first version as npm's documentation describes, and record it here.
3. Set the repository variable `NPM_PUBLISH` to `true` (Settings → Secrets and variables → Actions → Variables). No npm token is stored anywhere.
4. The next push to `main` then publishes a `next` prerelease (the first is `0.0.1-next.1`). Run `npm run release` to publish the first official version, `0.1.0`.

## Delivery

First review and merge this contract in a documentation-only PR. Then implement packaging and release workflows in a focused PR against it. Demonstrate archive installation before the initial publication. Configure npm access/trusted publisher with the owner as needed. Role views, claim commands, MCP, and wake-up adapters are independent features and must not be silently included or made prerequisites for this first release.
