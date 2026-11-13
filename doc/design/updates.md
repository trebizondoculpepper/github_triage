# Version check: two delivery slices

One global CLI installation per user/machine is recommended. Project identity stays local. This contract separates #51 from dependent #65; daily caching is not acceptance for the basic slice.

## #51: basic check and warning

During an eligible ordinary CLI invocation, compare the installed semantic version to npm’s matching channel: stable uses latest, opted-in prerelease uses next. Never suggest a downgrade. Source/development checkouts or unknown installed version skip with a diagnostic available on explicit inspection. Only metadata for this package is sent to npm; no identity, GitHub credentials or repository content.

A newer version produces one short advisory naming installed/available versions and `npm install -g @trebizondoculpepper/github-triage` (append @next for prereleases). No automatic install, privilege escalation or project dependency edit. Equal/older remote versions produce no routine chatter. Use a short timeout and non-blocking failure: registry unavailability neither prevents triage nor means up-to-date. Explicit offline disables network; offer an opt-out setting/flag. CLI text advisory goes to stderr; JSON/MCP stdout remains valid. MCP delivery is a separate adapter, never raw text on protocol stdout.

This initial slice may perform one bounded lookup per eligible invocation. Document that intermediate behavior rather than claiming daily checks before #65 ships.

## #65: daily cache and quiet notices

On first use or after 24 hours, refresh; no scheduler when unused. Use human-readable versioned JSON in `env-paths('github-triage').cache`, respecting OS/XDG locations and the library default suffix consistently. It is per-user and shared across projects, separate from settings/identity. Verify library/runtime compatibility before adding a dependency.

Store channel-keyed last attempt/success timestamps, cached available version, and last warning version/time. Throttle failed attempts too. Normally show at most one notice per channel/available-version per 24 hours; repeated invocations reuse state silently. A changed installed version must be compared against cached remote evidence, never blindly repeat an obsolete notice.

Use atomic replacement and a short-lived exclusive lock, bounded waiting and stale-lock recovery. Do not block useful work behind a stuck lock. Missing/corrupt/unwritable cache is recoverable; if safe coordination is unavailable, skip the optional check/notice rather than hammer npm. No SQLite/server. Do not persist secrets.

Implementation defaults (#65): cache file `update-check.json` (schema version 1, channel-keyed ISO timestamps and versions only); lock file beside it, bounded wait 250 ms, stale after 10 s; registry timeout 1.5 s from #51. A lookup is the only time the lock is held for long, so a concurrent invocation that cannot get the lock within the wait skips its optional check.

## Acceptance

Inject registry/clock/filesystem: compare equal/older/newer stable/prerelease versions; absent channel/version; timeouts/errors; offline/opt-out; stdout validity; first use/expiry; failed-attempt throttle; concurrent processes/stale lock; corrupt/unwritable cache; notification deduplication after an upgrade. Measure startup overhead. Default timeout and lock TTL are implementation choices documented and tested with bounded limits, not new product decisions.
