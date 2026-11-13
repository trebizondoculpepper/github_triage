# Incremental cache research (#198)

Research date: 2026-11-13. Bounded research spike under the owner-approved sequence on #198. It recommends a minimal design and refines the two experiment tickets, #202 (conditional refresh and lightweight manifests) and #203 (local evidence storage, isolation and recovery). Nothing here changes runtime behaviour, adds a cache, or authorizes production rollout. A changed contract still needs its own reviewed documentation PR before implementation.

## Contents

- Summary
- Method
- Facts: current cost
- Facts: manifest and conditional-request experiments
- Facts: what invalidates what
- Per-fact cacheability table
- Recommendation
- Storage
- Alternatives and trade-offs
- Limitations and unknowns
- Refinement of #202 and #203

## Summary

The default snapshot is already cheap: two GraphQL requests for this repository. A cache would not reduce that request count. The expensive path is all-state change collection, as used by `briefing --last 24h`: 8 requests, about 3 MB and about 18 seconds in one run. A cheap paginated GraphQL manifest of `number state updatedAt` (plus `headRefOid` for PRs) cost 4 requests, about 21 KB and about 2.2 seconds for every issue and PR in the repository. REST conditional requests through `gh api` returned HTTP 304 with no rate-limit charge, but `gh` exits 1 on a 304. The latency saving was small for small resources.

`updatedAt` changed for every comment, comment edit, label, closure, merge, review, rename and native dependency event observed. It did not cover cross-references, plain references or some check-run completions. No timestamp, head SHA or ETag covers CI state. The recommendation is to use a manifest to select which subjects need a full re-read, always fetch CI and merge-relevant facts live, and keep mutation-boundary reads uncached.

## Method

All measurements were read-only against `trebizondoculpepper/github_triage` on 2026-11-13 between about 19:20 and 19:35 UTC, from macOS over a home connection with authenticated `gh`. Each figure is one or two runs, not a statistical study, and latency will vary with the network and with GitHub. The scripts lived in a session scratch directory and are not committed. The method:

- **Current cost.** A `gh` wrapper placed first on `PATH` logged each invocation's exit code, stdout byte count and wall time while running `src/cli.ts` (default `--json`, `--issue 198 --json`, `briefing --last 24h --json`). The snapshot's own `metrics.requestCount` and `durationMs` were also read.
- **Manifest.** A Python script paginated `repository.issues` and `repository.pullRequests` separately (`first:100`, ordered by `UPDATED_AT DESC`), requesting `totalCount pageInfo number state updatedAt` and, for PRs, `headRefOid`. It recorded requests, bytes, wall time and `rateLimit.cost`.
- **Conditional REST.** For each of six endpoints, the script did a full `gh api -i` read, then the same read with `If-None-Match: <etag>`, then a full read again. It recorded status, exit code, bytes, time, `x-ratelimit-remaining` across the three reads, and ETag stability.
- **gh's own cache.** The script ran `gh api --cache 1h -i repos/.../issues/198` twice and compared timing, the `Date` header and the rate-limit header.
- **Invalidation.** For the 40 most recently updated issues and PRs, the script fetched the REST timeline and, for PRs, the head commit's check runs. It counted events whose timestamp was more than one second after the item's `updated_at`. Such an event is a proven case where `updatedAt` did not move. Zero counterexamples is evidence, not proof. Comment edits were tested separately: for 25 edited comments since 2026-11-01, the script compared the comment's `updated_at` with its parent issue's.

## Facts: current cost

| Operation                                             | gh requests | stdout bytes | gh wall time                   |
| ----------------------------------------------------- | ----------- | ------------ | ------------------------------ |
| Default snapshot `--json` (30 open issues, 1 open PR) | 2           | ~210 KB      | ~1.2–2.6 s (`durationMs` 1177) |
| `--issue 198 --json`                                  | 2           | ~210 KB      | ~2.1 s                         |
| `briefing --last 24h --json`                          | 8           | ~3.05 MB     | ~17.7 s                        |

The default snapshot already reads only open work, two GraphQL calls with nested comments, reviews and checks. Its rate-limit cost is small. `sharedCollect` in `src/polling.ts` coalesces concurrent identical collections but deliberately caches nothing afterwards. The existing `--cache`/`--offline`/`--checkpoint` files from #170 store a whole snapshot for explicit offline reading; they do not revalidate anything. `src/updatecache.ts` (#65) is the only durable per-user cache. It has a per-user cache directory, atomic replacement, a lock with stale-lock recovery, and treats a corrupt or foreign-schema file as absent.

## Facts: manifest and conditional-request experiments

| Read                                                                        | Requests  | Bytes             | Time             | Notes                                                          |
| --------------------------------------------------------------------------- | --------- | ----------------- | ---------------- | -------------------------------------------------------------- |
| GraphQL issue manifest, all states (111)                                    | 2         | 7.7 KB            | 1.22 s           | cost 1 per page; `totalCount` matched nodes                    |
| GraphQL PR manifest, all states (109)                                       | 2         | 13.8 KB           | 1.00 s           | includes `headRefOid`                                          |
| REST issue list `state=all&per_page=100` full                               | 1         | 625 KB            | 1.03 s           | weak ETag, no Last-Modified                                    |
| same, `If-None-Match`                                                       | 1         | ~1.2 KB (headers) | 0.73 s           | 304, exit 1, `gh: HTTP 304` on stderr                          |
| REST issue, comments, timeline, open pulls, `dependencies/blocked_by`: full | 1 each    | 1.4–62 KB         | 0.26–0.72 s      | all supplied an ETag; only the single issue had Last-Modified  |
| same, conditional                                                           | 1 each    | ~1.2 KB           | 0.34–0.67 s      | all 304, all exit 1                                            |
| `gh api --cache 1h` second call                                             | 0 network | —                 | 0.07 s vs 0.37 s | identical `Date` header: served from disk with no revalidation |
| GraphQL endpoint                                                            | —         | —                 | —                | no ETag returned; conditional GraphQL is not available         |

The rate-limit remaining count was unchanged across every 304 and dropped by one on each full read. For example, the issue list went 4999 → 4999 → 4998. One window reset during the run. GitHub documents this: an authorized 304 does not count against the primary rate limit.

Several things go wrong easily. Running `gh api graphql --paginate` with two connections sharing one `$cursor` variable never terminated and was killed at about 3 MB of output. A manifest must paginate each connection on its own, as `pages()` in `src/github.ts` already does. A nonzero `gh` exit must be classified by HTTP status, not treated as failure. ETags were weak (`W/`) on most endpoints, which is fine for `If-None-Match`.

## Facts: what invalidates what

Out of 40 items, 71 requests:

| Event                             | Observed         | After `updatedAt` (counterexamples) |
| --------------------------------- | ---------------- | ----------------------------------- |
| commented                         | 109              | 0                                   |
| labeled / unlabeled               | 75 / 24          | 0 / 0                               |
| closed / merged                   | 26 / 15          | 0 / 0                               |
| renamed                           | 2                | 0                                   |
| reviewed                          | 18               | 0                                   |
| committed (PR)                    | 36               | 0                                   |
| blocked_by_added / blocking_added | 25 / 19          | 0 / 0                               |
| mentioned / subscribed            | 40 / 40          | 0 / 0                               |
| referenced                        | 42               | **6**                               |
| cross-referenced                  | 134              | **24**                              |
| check run completed (head commit) | 75               | **2**                               |
| comment edited (separate sample)  | 25 of 166 edited | 0                                   |

Not observed in the sample: assignment changes, reopen, transfer, deletion, review-thread resolution, review dismissal, base-branch change, branch protection changes and blocker removal. These are **unknown**, not "covered".

## Per-fact cacheability table

"Validator" names what could tell a cache that a stored fact is stale. "Observed" means the sample above found no counterexample. It does not mean the validator is guaranteed.

| Fact used by triage                              | Candidate validator                              | Evidence                                                                                                      | Cacheable for display?                        | At mutation/merge boundary     |
| ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------ |
| Issue title, body, state, labels                 | manifest `updatedAt`                             | observed for rename, labels, close                                                                            | yes, with reconciliation                      | refresh live                   |
| Comments and comment edits                       | parent `updatedAt`                               | observed for create and edit                                                                                  | yes                                           | refresh live (claims/handoffs) |
| Assignees / ownership                            | parent `updatedAt`                               | **unknown** (none in sample)                                                                                  | only with a periodic full read                | always live                    |
| Reopen / transfer / deletion                     | manifest presence, `state`                       | **unknown**; a deleted or transferred item disappears from the manifest, which a complete manifest can detect | detect by absence only on a complete manifest | live                           |
| Native blockedBy/blocking                        | `updatedAt` on the item where the edge was added | observed for additions on both sides; removal **unknown**                                                     | yes, with reconciliation                      | live (`deps`)                  |
| Cross-references / closing references            | none                                             | **disproved**: 30 of 176 events after `updatedAt`                                                             | no                                            | live                           |
| PR head commit                                   | manifest `headRefOid`                            | is the revision itself                                                                                        | yes                                           | live                           |
| PR reviews                                       | PR `updatedAt`                                   | observed for submission; dismissal **unknown**                                                                | yes, with reconciliation                      | live                           |
| Review thread resolution                         | none known                                       | **unknown**; no timeline event                                                                                | no                                            | live                           |
| Checks / CI                                      | none                                             | **disproved**: 2 of 75 completions after `updatedAt`; reruns do not change the head SHA                       | no                                            | live                           |
| mergeable / mergeStateStatus / base / protection | none                                             | computed by GitHub and dependent on the base branch and settings                                              | no                                            | live                           |
| Repository settings, permissions                 | none                                             | out of scope                                                                                                  | no                                            | live                           |

## Recommendation

These are recommendations, separate from the facts above.

1. **Do not cache the default snapshot.** It is two requests. Caching it would add staleness risk without reducing the request count.
2. **Use a manifest only to select re-reads in change collection (briefing/polling).** Paginate `number state updatedAt` (and `headRefOid`) per connection. Compare with stored entries. Fully re-read only subjects whose `updatedAt`, state or head changed, or that appeared or disappeared. Then fetch live, every time, the facts the table marks as not cacheable: CI, mergeability, cross/closing references and review-thread resolution, for open PRs and selected subjects. Measured upper bound on the saving for this repository: about 21 KB in 4 requests in place of about 3 MB in 8. The real saving is the manifest plus the changed subjects' detail reads, and #202 must measure it.
3. **Overlap watermarks rather than trusting them.** Compare whole manifests, not just "updated since T". Re-read anything updated within a safety margin before the last observed T0, and run a full reconciliation read periodically (for example daily, or every N runs). A failed or partial page leaves the previous manifest in force and marks coverage incomplete. It never advances the stored manifest.
4. **Reserve conditional REST for cheap revalidation of individual hot subjects**, such as an issue's comments or `dependencies/blocked_by`. Classify 304 by HTTP status, since `gh` exits 1 on it. Do not use `gh api --cache` for freshness: it is TTL reuse with no revalidation.
5. **Cached evidence never authorizes.** Claims, releases, merges and dependency mutations keep their existing live read immediately before acting (already in `src/cli.ts`). Output from cached data carries its observation age and coverage, as `--offline` does today.
6. **Reuse, don't parallel.** Store manifests alongside the #170 snapshot/checkpoint envelope and serve #32 (polling) and #42 (shared server) from the same store. Do not create a second cache format.

## Storage

These are recommendations for #203; nothing here has been tested.

- Put the store in the per-user cache directory (`env-paths('github-triage').cache`, as #65 does), never in project configuration or the repository.
- Separate stores by host, repository and authenticated login, because visibility differs between tokens. Unknown auth context means no reuse.
- Use one JSON file per host/repository, with `schemaVersion`, the observed time, a coverage marker and the manifest entries. Reuse `filelock.ts` and atomic replacement from `updatecache.ts`.
- Treat a corrupt file, a foreign schema or a failed lock as empty and fall back to a live full read, never to failure. Use bounded retention, for example dropping entries not seen in a complete manifest.
- Do not store Git objects or diffs.

## Alternatives and trade-offs

- **gh `--cache` TTL.** No code, but no revalidation and a fixed staleness window. It is not acceptable as evidence of current state.
- **REST ETag per subject.** Revalidation is free against the rate limit, but it takes one round trip per resource. Latency barely improved (0.34–0.73 s versus 0.26–1.03 s), so it does not scale to many subjects. GraphQL, which this product uses, has no ETag.
- **GraphQL manifest plus selective re-read (recommended).** A few requests, completeness by `totalCount`/pagination, and it detects disappearance. It only invalidates facts that move `updatedAt`.
- **Webhooks or a daemon.** These are out of scope for this research (#42/#32 own any server), and they need hosting and delivery guarantees.
- **Events API.** Not evaluated. It is paginated, lossy beyond its retention window, and its coverage is unknown.

## Limitations and unknowns

- This is one repository, small (about 220 items), with one or two runs per figure. Latency and payload will differ on large repositories.
- The invalidation sample is 40 recent items; event types never observed are unknown.
- No mutation experiments were done, by rule. Sequenced change-then-observe tests belong in #202, against a disposable repository or with injected fixtures.
- The GraphQL secondary rate limits and point costs at larger page sizes were not explored.
- No atomic repository snapshot exists. A manifest and the follow-up reads are taken at different moments.

## Refinement of #202 and #203

- **#202 (conditional refresh and manifests).** Scope it to a read-only experiment that adds a manifest-diff path to all-state change collection behind an explicit flag, with injected `gh` fixtures. It should measure requests, bytes and latency against today's briefing on this repository. It should add a missed-change test matrix for the unknown rows above (assignment, reopen, transfer, deletion, thread resolution, blocker removal, review dismissal, base change). That matrix runs against a disposable test repository, not production. It should classify `gh` exit-1/304 correctly. Readiness: ready after a contract docs PR.
- **#203 (local storage and recovery).** Scope it to the storage module: location, host/repo/login keying, schema, atomic write, lock, corruption fallback, retention. It should share code with `updatecache.ts`/`filelock.ts` and the #170 envelope. Tests must be filesystem-injected, with no network. Readiness: ready after the same contract PR. It can proceed in parallel with #202.
