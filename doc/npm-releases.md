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

## Delivery

First review and merge this contract in a documentation-only PR. Then implement packaging and release workflows in a focused PR against it. Demonstrate archive installation before the initial publication. Configure npm access/trusted publisher with the owner as needed. Role views, claim commands, MCP, and wake-up adapters are independent features and must not be silently included or made prerequisites for this first release.
