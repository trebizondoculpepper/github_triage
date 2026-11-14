# Conditional refresh and lightweight manifest experiment (#202)

## Contents

- [Summary and recommendation](#summary-and-recommendation)
- [What was built](#what-was-built)
- [Method](#method)
- [Live measurements](#live-measurements)
- [Fixture comparison and missed-change matrix](#fixture-comparison-and-missed-change-matrix)
- [Per-fact findings](#per-fact-findings)
- [TTL reuse versus revalidation](#ttl-reuse-versus-revalidation)
- [Source evidence](#source-evidence)
- [Limitations](#limitations)
- [Reproduce](#reproduce)

## Summary and recommendation

**Recommendation: narrow.** Adopt the manifest-select pattern from #198 for all-state change collection only, with the volatile facts always read live, and a full reconciliation read at a bounded interval. Use REST conditional requests only for a small, named set of hot per-subject resources. Stop pursuing `gh api --cache` as a freshness mechanism and stop pursuing conditional GraphQL. Nothing here justifies caching the default snapshot or any mutation-boundary read.

Reasons:

1. **The manifest is cheap and complete.** For all 375 issues and PRs in this repository it cost 4 GraphQL requests, 4 points, about 41 KB and about 2.1 s, warm or cold. It detects additions, state changes, head changes and (when complete) disappearance.
2. **REST conditional reads save points and bytes, not time.** A 304 was free against the primary rate limit and cut 9 resources from about 868 KB to about 11 KB, but total latency barely moved (4.2 s full versus 3.9–4.0 s revalidated, three warm runs). Each resource still needs its own round trip, so it does not scale to many subjects.
3. **GraphQL has no validators.** The endpoint returned neither `ETag` nor `Last-Modified`, ignored `If-None-Match`/`If-Modified-Since` (HTTP 200, point charged), and the GraphQL rate-limit documentation does not describe conditional requests. The product's main read path therefore cannot revalidate; it can only be made narrower.
4. **`updatedAt` and the head SHA do not cover every fact.** Live, 3 of 5 check runs on the open PR's head completed after the PR's `updatedAt`, and 2 of 17 cross-references landed after their subject's `updatedAt`. In the fixtures, a manifest-only strategy missed CI re-runs, thread resolution, cross-references and mergeability changes; adding a live read of those facts for open subjects removed those misses at a cost of one extra GraphQL request.
5. **Unknown events stay unknown.** Assignment changes, native edge removal and review dismissal were not observed in any live sample. Modelled worst-case (no `updatedAt` change), the recommended strategy misses them until the next reconciliation, which the simulator now performs: at 31 minutes after the last full read (R16, R17) it re-reads everything and misses nothing, at the cost of a full read. They must not be called timestamp-covered.
6. **TTL reuse is not evidence.** `gh api --cache 1h` served the second call from disk in 61 ms with the identical `Date` header and no rate-limit change: it never asked GitHub. In the fixtures it missed every change.

What would need to be true to move from "narrow" to "adopt" for production: a disposable-repository run of the unknown rows (assignment, edge removal, review dismissal, transfer, base change) that shows whether `updatedAt` moves, and a measurement of the manifest-select path inside `briefing --last` against today's 8-request, ~3 MB collection. Both are separate deliveries; this experiment does not activate them.

## What was built

All under `doc/reports/examples/cache-experiments/`, following the convention of the other examples and the contract in `doc/design/cache-experiments.md`. Nothing is wired into the product, and no production cache was created.

- `refresh.ts` — the experiment model: per-fact validator table (`VALIDATOR`, from #198), manifest construction, `diffManifest` (absence from a partial manifest is `absentUnknown`, never deletion), `advanceManifest` (a failed, cancelled or truncated page never advances the manifest; overlapping pages deduplicate by stable identity), `classifyGh` (classifies by the HTTP status line, so a 304 with `gh` exit 1 is "not modified" and a missing status line is a transport error), `applyConditional` (a 304 reuses only the exact stored payload for the same context key and validator; anything else is a miss, never empty evidence), and a synthetic fixture simulator comparing five strategies across 18 scenarios with expected misses written into the scenario table. The manifest strategies reconcile with a full re-read (counted in `reconciliations` and in the request and byte totals) when the last full read is 30 or more fixture minutes old or the manifest has a coverage gap; facts are only counted as validated inside that window.
- `refresh.test.ts` — 30 tests: one per scenario (expected versus observed misses for every strategy) plus manifest, watermark, reconciliation, rate-limit and 304 handling, inventory-discovery cost and PR head refresh through the pull resource.
- `refresh-run.test.ts` — 21 tests with an injected `gh`: a failed page, a GraphQL 200 with `errors` and a null repository or connection, the one-page limit, overlapping pages that fall short of `totalCount`, and a `totalCount` that changes mid-scan all produce a stale, unadvanced read with its diagnostic and original observation time, never an unchanged refresh; a whole probe run stays within the per-source, page and total limits; an exhausted total stops every later section; nothing is sent after a secondary limit, a 429, a GraphQL `RATE_LIMITED` error or a response with zero remaining; saved check runs are not sampled when their revalidation failed, and a fresh 200 without an ETag is sampled instead of the saved copy; entries from a stale manifest never enter the invalidation measurements; a corrupt state file, or valid JSON of the wrong shape, is a miss; state saved for one host is never reused or revalidated against another; first-page-only coverage survives a later 304; an unknown login means no reuse.
- `refresh-run.ts` — the runner. Fixture mode (default) prints a `schemaVersion: 1, kind: cache-experiment` JSON report with no network. `--live` is explicit, requires `--repo` and `--state` (a file outside the repository holding the previous manifest and ETags) and is serial. Every live request, including the login lookup, goes through one shared budget that enforces the contract's limits together: at most ten requests and one page per source per run, and 60 requests per run in total, checked before sending. Sources are `auth`, `manifest:issues`, `manifest:pullRequests`, `rest`, `probe:if-modified-since`, `probe:graphql`, `probe:gh-cache` and `probe:invalidation`; a source that runs out is listed under `skipped`. It stops at the first rate-limit signal and sends nothing after it: HTTP 429; 403 with zero primary remaining, a `Retry-After` header or a secondary-rate-limit message; a GraphQL 200 whose `errors` include type `RATE_LIMITED`; or any response reporting `X-Ratelimit-Remaining: 0`. A saved payload is reused only when its resource returned a matching 304 on the same run; the check-run sample uses the body returned on this run (a 200, with or without an ETag, or the saved copy after a matching 304) and otherwise reports the resource as stale or unknown. Every reported value comes from a request that succeeded on the same run: the invalidation sample, the PR head and the PR `updatedAt` use only manifest entries observed on this run, never a stale manifest's entries; the GraphQL and `gh --cache` probes report `unknown` when a response failed or lacked the header they compare; unreadable timeline or check-run bodies are listed as unread rather than counted; only completed check runs count as completions, and queued or in-progress runs are reported separately as `checkRunsNotCompleted`. A manifest is complete only when every page succeeded, the last page has no successor, each connection's pages agree on `totalCount` and the deduplicated entries match it. Otherwise the run reports `manifest.coverage: "stale"` with the diagnostic and the previous observation time, keeps the previous manifest and emits no diff. Every request passes `--hostname` explicitly (from `--hostname`, else `GH_HOST`, else `github.com`), and the saved context key is host, repository, login and profile, so state from one host is never sent to another. Restored state is used only if its manifest entries and stored resources have the expected shape; otherwise it is a miss with a diagnostic. REST lists and timelines with a `rel="next"` link are marked first-page-only, that coverage is stored with the payload so a later 304 still reports `validated (first page only)`, and the invalidation sample lists the subjects it only saw in part. It never issues a write.

## Method

Live runs were read-only against `trebizondoculpepper/presidential-daily-briefing` on 2026-11-14 between 18:27 and 18:30 UTC (one cold run, three warm runs), from macOS over a home connection, with `gh` 2.103.3 and Node 26.7.0, source revision `55e0760`. The repository had 195 issues and 180 PRs, one PR open (#365). Per-subject resources used issue #202 and PR #365. Each figure is one run, not a statistical study.

- **Cold run** (`--probe`): GraphQL manifest of both connections, paginated separately (`first:100`, `number state updatedAt`, plus `headRefOid` for PRs, with `rateLimit{cost}`); full REST reads of 9 resources with `gh api -i`; an immediate `If-Modified-Since` read where `Last-Modified` was returned; GraphQL validator probe; `gh api --cache 1h` twice; invalidation sample over the 8 most recently updated subjects (REST timeline events timestamped more than one second after the subject's `updatedAt`) and the open PR's head check runs.
- **Warm runs**: the same manifest, diffed against the stored one, and `If-None-Match` revalidation of the same 9 resources with the stored ETags.
- **Changed run**: no write is allowed, so a change can only be observed if the repository changes on its own between runs. See [Live measurements](#live-measurements) for what happened. The changed cases are otherwise covered by the fixtures.

Request volume actually used, including the ad-hoc checks while building the runner: about 54 core requests (29 of them 304s, which did not count against the limit) and about 20 GraphQL points. Both are far below the 200/200 ceiling set for this ticket. **Contract deviation:** these runs predate the runner's enforcement of the contract's live bound of one page per source per run. Each run read two manifest pages per connection, and the cold run sent 11 REST requests (9 resources plus 2 `If-Modified-Since`) without separating them into sources. The figures are reported as measured; the runner now enforces the bound. Because this repository has more than 100 issues and more than 100 PRs, a contract-bounded live run can only produce a partial manifest here and reports it as stale. Measuring a complete live manifest again would need a contract change.

## Live measurements

| Read (this repository, 375 subjects)                | Requests | Points    | Bytes   | Time        | Notes                                                                                               |
| --------------------------------------------------- | -------- | --------- | ------- | ----------- | --------------------------------------------------------------------------------------------------- |
| GraphQL manifest, cold                              | 4        | 4 GraphQL | 40.6 KB | 2.10 s      | cost 1 per page; `totalCount` 195 + 180 matched                                                     |
| GraphQL manifest, warm (unchanged)                  | 4        | 4 GraphQL | 40.6 KB | 2.04 s      | no conditional GraphQL, so warm costs the same as cold                                              |
| 9 REST resources, full (cold)                       | 9        | 9 core    | 868 KB  | 4.21 s      | issue, comments, timeline, blocked_by, pull, reviews, review comments, issue list (100), check runs |
| same, `If-None-Match` (warm, unchanged), three runs | 9 each   | 0         | 10.9 KB | 3.91–4.04 s | all 304, all `gh` exit 1; remaining count unchanged across them                                     |
| `If-Modified-Since` on issue and pull               | 2        | 0         | 2.5 KB  | 0.69 s      | both 304; only these two resources returned `Last-Modified`                                         |
| GraphQL `If-None-Match` + `If-Modified-Since`       | 1        | 1 GraphQL | 1.2 KB  | 0.32 s      | HTTP 200; no `ETag` or `Last-Modified` on any GraphQL response                                      |
| `gh api --cache 1h`, first / second call            | 1 / 0    | 1 / 0     | 6.8 KB  | 357 / 61 ms | identical `Date` header: second call never reached GitHub                                           |

Per-resource latency did not depend much on outcome: a 304 took 0.28–0.87 s, a full read 0.28–0.94 s. The largest saving was the 100-item REST issue list, 604 KB down to 1.2 KB, with time unchanged (0.94 s versus 0.85–0.87 s).

The `dependencies/blocked_by` responses reported `X-Ratelimit-Resource: core` but a separate remaining count (4999) from the other core reads. This was not investigated further; it does not change the conclusion.

**Changed case.** Between the cold run and the last warm run the manifest diff was empty and every resource revalidated with 304, so no natural change was captured live. Counting of a changed subject (one full re-read, one core point per changed resource) therefore comes from the fixtures, not from a live observation.

**Invalidation sample** (8 most recently updated subjects, one open PR's head check runs):

| Event                               | Seen      | After the subject's `updatedAt` |
| ----------------------------------- | --------- | ------------------------------- |
| commented                           | 35        | 0                               |
| labeled / unlabeled                 | 35 / 11   | 0 / 0                           |
| closed / merged                     | 3 / 2     | 0 / 0                           |
| blocked_by_added / blocking_added   | 4 / 1     | 0 / 0                           |
| parent_issue_added                  | 2         | 0                               |
| mentioned / subscribed / referenced | 2 / 2 / 2 | 0 / 0 / 0                       |
| cross-referenced                    | 17        | **2**                           |
| check run completed (PR #365 head)  | 5         | **3**                           |

This agrees with #198: cross-references and check runs are not covered by `updatedAt`. Zero counterexamples elsewhere is evidence, not proof.

## Fixture comparison and missed-change matrix

The fixture is synthetic: 30 issues (10 open) and 20 PRs (3 open). Costs are model units scaled from the #198 figures, not live measurements. Strategies:

- **full** — re-read every subject and fact (the correctness baseline).
- **ttl** — `gh --cache`-style reuse inside the TTL, no network.
- **manifest** — manifest, then full re-read of added or changed subjects only.
- **manifest+live** — as manifest, plus a live read of checks, cross-references, review threads and mergeability for every open subject (the #198 recommendation).
- **conditional** — a conditional read of the REST issue list for inventory discovery (100 per page; 200 when any subject was added, removed or updated, otherwise 304), then one REST `If-None-Match` per subject resource, plus a live GraphQL read of threads and mergeability for open PRs (they have no REST validator). A PR's core facts, state and head come from the pull resource, not the issue resource.

Warm cost with nothing changed (R0): full 3 requests / 1626 KB; ttl 0 / 0; manifest 2 / 4 KB; manifest+live 3 / 48 KB; conditional 242 requests (1 GraphQL point, 0 core points) / 298 KB. One changed subject adds one GraphQL request and about 28–40 KB to the manifest strategies. For conditional, a change that moves `updatedAt` also turns the inventory read into a 200: R1 costs 2 core points and about 615 KB, and the new issue in R15 costs 246 requests, 5 core points and about 630 KB. A change that does not move `updatedAt` (for example R5) costs one core point. A reconciliation (timed, or forced by a partial manifest) costs the manifest plus a full read: 5 requests and about 1.6 MB in the model.

Missed changes after one warm refresh. "Bump" says whether `updatedAt` moves: observed in #198 or here, observed not to, or **assumed not** (never observed; modelled as worst case).

| ID  | Change                                       | Bump         | full | ttl | manifest | manifest+live | conditional |
| --- | -------------------------------------------- | ------------ | ---- | --- | -------- | ------------- | ----------- |
| R0  | nothing                                      | —            | 0    | 0   | 0        | 0             | 0           |
| R1  | issue comment added                          | observed     | 0    | 1   | 0        | 0             | 0           |
| R2  | comment edited                               | observed     | 0    | 1   | 0        | 0             | 0           |
| R3  | label or title changed                       | observed     | 0    | 1   | 0        | 0             | 0           |
| R4  | PR head changed                              | observed     | 0    | 3   | 0        | 0             | 0           |
| R5  | CI re-run on same head                       | observed-not | 0    | 1   | **1**    | 0             | 0           |
| R6  | review thread resolved                       | assumed-not  | 0    | 1   | **1**    | 0             | 0           |
| R7  | cross/closing reference added                | observed-not | 0    | 1   | **1**    | 0             | 0           |
| R8  | protection change alters mergeability        | assumed-not  | 0    | 1   | **1**    | 0             | 0           |
| R9  | native blocked-by edge removed               | assumed-not  | 0    | 1   | **1**    | **1**         | 0           |
| R10 | review dismissed                             | assumed-not  | 0    | 1   | **1**    | **1**         | 0           |
| R11 | assignment changed                           | assumed-not  | 0    | 1   | **1**    | **1**         | 0           |
| R12 | issue reopened                               | observed     | 0    | 1   | 0        | 0             | 0           |
| R13 | issue transferred/deleted, complete manifest | observed     | 0    | 1   | 0        | 0             | 0           |
| R14 | deleted, partial manifest                    | observed     | 0    | 1   | 0        | 0             | 0           |
| R15 | new issue                                    | observed     | 0    | 5   | 0        | 0             | 0           |
| R16 | assignment changed, 31 min after full read   | assumed-not  | 0    | 1   | 0        | 0             | 0           |
| R17 | review dismissed, 31 min after full read     | assumed-not  | 0    | 1   | 0        | 0             | 0           |

In R14, absence from a partial manifest is reported as `absentUnknown` and never deletes a subject; the coverage gap forces a full re-read, which then sees the deletion. The remaining manifest+live misses (R9–R11, five minutes after a full read) are exactly the unknown rows from #198. R16 and R17 repeat two of them after the 30-minute control and show that the simulated reconciliation catches them, so they bound staleness to the interval rather than persist. Conditional REST catches everything in the model only because the model assumes every resource's ETag tracks its content; that assumption held for every 304/200 observed live but was not exercised by a live change.

The handling cases are tested directly: 304 with `gh` exit 1 is "not modified"; 304 with no stored payload, another context key or a different validator is a miss; HTTP 403 with zero remaining is a rate-limit stop; no status line is a transport error; a failed, cancelled or truncated page does not advance the manifest.

## Per-fact findings

| Fact                                 | Changes without `updatedAt` / head SHA moving? | Cheapest correct refresh                                      |
| ------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| Issue/PR core (title, labels, state) | no counterexample (here and #198)              | manifest select                                               |
| Comments, comment edits              | no counterexample                              | manifest select; REST conditional for a hot subject           |
| Reviews (submission)                 | no counterexample; dismissal unknown           | manifest select + reconciliation                              |
| Checks / CI                          | **yes** (3 of 5 live; reruns keep the SHA)     | always live for open PRs                                      |
| Native dependencies                  | additions covered; removal unknown             | manifest select + reconciliation; `deps` live before mutation |
| Cross/closing references             | **yes** (2 of 17 live; 30 of 176 in #198)      | always live for open subjects                                 |
| Review-thread resolution             | unknown; no timeline event                     | always live for open PRs                                      |
| Mergeability, base, protection       | computed by GitHub                             | always live                                                   |
| Assignees                            | unknown                                        | reconciliation; always live before claims                     |

## TTL reuse versus revalidation

These are different mechanisms and the experiment keeps them apart. **TTL reuse** (`gh api --cache`) answers from a local copy until a deadline without contacting GitHub; its output is stale/unvalidated by construction and the fixture counts every change inside the TTL as missed. **Revalidation** (`If-None-Match`/`If-Modified-Since`) contacts GitHub every time and reuses the stored payload only when GitHub answers 304 for that exact resource and validator; it is fresh evidence for that one resource and nothing else. **Manifest selection** is a third thing: it revalidates subject identity, state, `updatedAt` and head, not the related facts, which is why the volatile facts are read live alongside it.

## Source evidence

- GitHub Docs, "Best practices for using the REST API", section "Use conditional requests": authenticated conditional requests that return 304 do not count against the primary rate limit. https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests (accessed 2026-11-14).
- GitHub Docs, "Rate limits and query limits for the GraphQL API": point-based limits; no conditional-request mechanism described. https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api (accessed 2026-11-14).
- GitHub CLI manual, `gh api`: `--cache <duration>` "Cache the response, e.g. 3600s, 60m, 1h". https://cli.github.com/manual/gh_api (accessed 2026-11-14).
- Live headers in this run: `ETag` on every REST resource tested (weak `W/`), `Last-Modified` only on the single issue and single pull, neither on GraphQL; `Cache-Control: private, max-age=60`.
- Prior evidence: `doc/reports/incremental-cache-research.md` (#198) and the contract `doc/design/cache-experiments.md` (#297).

## Limitations

- The complete-manifest live figures (4 GraphQL requests) came from runs that exceeded the contract's one-page-per-source bound; see [Method](#method). The current runner cannot repeat them on this repository without a contract change.
- One small repository (375 subjects, one open PR), one run per figure, one network. Latency varies; treat times as indicative.
- No live changed case was captured, because no writes are allowed and the repository did not change between runs. Changed-subject costs come from the fixtures.
- The fixture simulator's costs are model units. Its missed-change counts depend on the validator table, which encodes #198's evidence and worst-case assumptions for unobserved events.
- The unknown rows (assignment, edge removal, review dismissal, transfer, base change, thread resolution) were not exercised against GitHub. That needs a disposable repository with permitted writes.
- The invalidation sample is 8 subjects and 5 check runs. GraphQL secondary limits and larger page sizes were not explored.
- No atomic repository snapshot exists; the manifest and follow-up reads are taken at different moments.
- Storage, locking and isolation are #203 and are not covered here.

## Reproduce

From the repository root, after `npm ci`:

```sh
# Fixture comparison and tests (no network)
npx tsx doc/reports/examples/cache-experiments/refresh-run.ts
npx vp test run doc/reports/examples/cache-experiments
npx tsc -p doc/reports/examples

# Live, read-only, bounded. Keep the state file outside the repository.
STATE="$(mktemp -d)/refresh-state.json"
REPO=trebizondoculpepper/presidential-daily-briefing
# cold run with probes (at most 10 requests and 1 page per source, 60 in total; the manifest is partial here)
npx tsx doc/reports/examples/cache-experiments/refresh-run.ts --live --repo "$REPO" --state "$STATE" --pr 365 --issue 202 --probe
# warm run (up to 10 core requests, mostly 304, plus 2 GraphQL points); repeat later for a changed case
npx tsx doc/reports/examples/cache-experiments/refresh-run.ts --live --repo "$REPO" --state "$STATE" --pr 365 --issue 202
```

Replace `--pr` with a currently open PR. Each live run also reads `user` once, inside the budget, to build the context key; the login is not printed.
