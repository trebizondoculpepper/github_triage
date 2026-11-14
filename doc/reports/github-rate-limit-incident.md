# GitHub read quota incident and follow-up plan

Research #292, 2026-11-14. Researcher: farhad_taphrale, Codex session; model/enclosing client version not exposed. Inspected source main `20874ed296de8235918dae841d97f09cabdd733d` with the locally installed CLI/MCP build. Bounded read-only probes used the existing authenticated gh boundary; no tokens, private bodies, query strings or user IDs are included here. This report is diagnosis, not a production fix or a load test.

## Finding

A normal-size repository (35 open tickets in one complete snapshot, 36 in the later inventory) experienced failed read-only catch-up collection. A bounded reproduction captured an **HTTP 200 GraphQL error with type RATE_LIMIT, code graphql_rate_limit and an explicit primary-quota-exhausted message**. Its response headers reported limit 5000, used 5000, remaining 0. This establishes the immediate rejection reason, not which agent or command consumed the allowance.

Successful preceding inventory responses reported nonzero remaining quota. One pair reported issue cost 3, remaining 1633 and PR cost 54, remaining 1579; a later pair reported remaining 1576 and 1522. The rejected all-state history response then reported zero and a reset timestamp 29 seconds different from the successful responses. Retain this discrepancy. We did not establish whether response timing, request/authentication context or another factor explains it, and must not claim the failed query consumed the entire remainder. No token/account changes were made. Per-request sanitized headers, request IDs and timing are needed to correlate future observations.

After that rejection we stopped GraphQL probes rather than continue hammering the endpoint. REST had separately observed available quota and supplied a bounded inventory/administration fallback with the same authenticated identity; that does not demonstrate a universal fallback, nor authorize ignoring secondary backoff. CodeRabbit's OSS review quota is an unrelated service limit.

## Measured query behavior

| Operation                                                      | Measured primary cost | Response size including captured headers | Outcome                                    |
| -------------------------------------------------------------- | --------------------- | ---------------------------------------- | ------------------------------------------ |
| Open issue inventory, nested labels/comments/dependencies      | 3                     | about 390 KB                             | Success                                    |
| Open PR inventory, two open PRs with nested review/check facts | 54                    | about 40 KB                              | Success                                    |
| Catch-up all-state issue-history page                          | Not returned          | about 1.3 KB error response              | Primary quota rejection before usable data |

These are individual observations, not a statistical benchmark or a promise of constant costs. The successful normal inventory pair cost 57 points. A hypothetical exclusive 5000-point allowance would fund about 87 such pairs before accounting for history, extra pages, other tools and other agents. This arithmetic illustrates sensitivity to repeated scans, not attribution of the incident or a safe polling interval.

`src/github.ts` collection currently fetches both repository inventories before focused issue handling. Each list page asks for up to 50 subjects. Common fields include full bodies, labels(first:100) and comments(first:100); PRs add closing references, review threads and their comments, reviews and check contexts. History repeats rich fields for all-state pages; source page caps bound traversal but do not make each query cheap. A rendered top-five/top-ten limit does not reduce collection. Cached output is available explicitly, but routine independent calls do not automatically share one verified collection.

## Diagnostic gap

The collector requests remaining/resetAt but not cost. Metrics count requests and wall time; two requests can hide a 3-versus-54 point difference. The gh boundary does not request response headers. `rateLimitFailure` retains bounded retry/reset metadata only if matching header text happens to be present, then emits a generic retry-after-reset message even when neither value is available. The structured discriminator checks RATE_LIMITED while the observed failure used RATE_LIMIT; stderr text happened to recognize it. Broad response-text matching can also confuse ordinary content with an error reason, so structured error/header parsing needs tests. This observation does not prove that the incident itself was a misclassification: its raw error was an actual exhausted-quota response.

Do not infer the absence of a limit from an independently sampled positive balance. Do not infer primary exhaustion merely from a generic 403 either. Preserve primary, secondary, node/resource, timeout, access and unknown categories and say when evidence is insufficient. Keep sanitized diagnostics separate from repository content and credentials.

## Technical work and sequencing

- #293: per-operation quota/cost/error telemetry and grounded recovery. Contract first, then injected implementation tests.
- #294: lightweight discovery and targeted hydration profiles for ordinary and focused reads. Preserve explicit full intake; required eligibility/authority facts must be hydrated or unknown, not silently absent.
- #295: graceful read-only degradation with current/history coverage and dated stale-cache fallback; never advance checkpoints or replace a good cache after incomplete collection. Never reuse cached authority for mutations.
- Existing #202/#203: conditional refresh and storage/isolation experiments from #198. Their expected benefit is now L because dependable read reuse is important to core triage, but production savings/correctness remain unproved. No new mandatory daemon, database or paid limit upgrade.

Observation/diagnosis is a contained M deliverable. Diagnostics, lighter collection and useful degraded reads are impact L improvements to common agent workflows. Complexity remains for implementers to assess independently. The first work should be better measurements and reduced redundant collection, followed by safe reuse justified by experiments. A wholesale backend redesign is unnecessary to begin.

## Acceptance for the follow-ups

Use injected request/clock/filesystem boundaries to test RATE_LIMIT and RATE_LIMITED, primary zero remaining, secondary limits with nonzero primary balance, absent headers, partial GraphQL data, timeouts, cancellation and schema compatibility. Compare representative profiles by cost, request count, bytes and source coverage, including many closed PRs but few open ones. Reserve targeted live validation until quota is available; no stress test is required. Shared-agent load and duplicate in-flight collection should be measured rather than guessed.

A degraded report must distinguish no changes from unavailable history and stale data from fresh facts. On quota errors honor Retry-After/reset and bounded backoff. A separate REST profile needs its own coverage/permission semantics; it is not an excuse for retry storms or rotating credentials. Preserve all fresh state/authority checks before claims, release, delivery completion and merges.

## Primary sources

[GitHub GraphQL limits](https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api) describes cost reporting, shared user allowance, secondary limits and error/backoff behavior. The relevant inference is that both query shape and aggregate authenticated activity matter; ticket count alone is inadequate. Accessed 2026-11-14.

[GitHub issue dependency REST API](https://docs.github.com/en/rest/issues/issue-dependencies) documents the native links used for these administrative follow-ups when the GraphQL-dependent helper was unavailable. No new authentication or custom migration was introduced. Accessed 2026-11-14.
