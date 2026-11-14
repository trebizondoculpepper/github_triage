# Verified-author complexity provenance

Documentation-first contract for #269, implementing the owner's already-approved trust consistency decision. Reuse the #215 TrustDecision boundary and existing impact provenance scanner. Current complexity labels remain authoritative for current size; this document changes which explanation/history records count as trusted, not who may see a bug report or how labels are stored.

## Why

Impact history already checks repository-write author/editor authority; complexity currently accepts parsed history without that check. Untrusted comments must not supply trusted rationale, estimator attribution, idempotency evidence or a fabricated claim that a changed ticket was assessed recently. Do not add signing, accounts, credentials, a new permission service or a second parser.

## Shared scanner and collection

Use scanProvenance with the registered metric descriptor and an injected TrustDecision for both metrics. The observed GitHub author and any relevant editor must meet the existing current write/maintain/admin rule; reported estimator text is attribution only. Reuse its bot/app, editor and unknown handling exactly, not a new role-label authority rule. Memoize permission decisions only within the current repository/collection run under the existing resolver; never cache them as durable authority. Disabled complexity does not require a history trust scan solely for this metric.

Collect the author/edit fields already fetched by the full collector and add those fields to complexity writer targeted comment reads (as impact already does). No new repository-wide collection or per-comment network call; one verified author decision can be reused in-run. Apply trust before deriving recorded rationale, freshness or retry matches. A pure report builder consumes normalized scanner decisions prepared by an asynchronous collection boundary; do not insert hidden GitHub requests into ranking/presentation.

Newest-first semantics mirror impact: accept the newest valid trusted metric record; record/skip confirmed-untrusted records while continuing to older candidates; stop at the newest candidate whose author/editor authority is unknown, rather than trusting an older record behind it. Truncated/unordered required history makes provenance unknown. Preserve current metric/version parsing and malformed-marker handling; this is not a new general delivery-record classifier. Provenance from another metric never supplies complexity history.

## Size and history are separate evidence

With complete labels, retain the recognized size (or missing/conflicting/invalid set) exactly as before. No trusted provenance does not delete labels or substitute another metric's size. Report recorded:null when no trusted record is available; do not copy an untrusted explanation or estimator into trusted recorded fields. Expose additive provenanceAuthority (trusted|untrusted|unknown|none) and ignoredProvenance reason strings in complexity read entries; retain existing schema versions and fields. Treat untrusted-only history as no trusted record, and unknown-authority/incomplete history as explicitly unknown provenance.

Use existing stale/no-record handling when trusted history is absent, and current guidance-version/body-edit/size-mismatch checks only on accepted trusted history. Unknown provenance makes freshness unknown and produces inspection with a reason, not a trustworthy current assessment or a fictitious edit time. The label size can still be displayed with that qualification. Blended ranking must not turn uncertain freshness into a known easy win or cross-role confidence boost; this follows its existing requirement for current valid paired evidence. Unestimated/conflicting/invalid label handling itself is unchanged.

For already trusted, complete histories, retain current output values and ordering apart from the new additive authority fields. Required permission failures must be bounded and diagnosable, not an excuse for endlessly querying author history or treating missing permission as trusted.

## Recording and retry

The current authenticated writer must pass the same authority rule before changing labels/history. Scope and value justification, optional replace guard, individually applied label operations and partial-write reporting remain unchanged. The writer uses the shared scanner for idempotency: only a trusted matching stored record proves an identical request completed. A record with unknown authority is not a successful retry receipt; after ordinary fresh-label/authority validation, record the caller's justified assessment using the same fresh-provenance behavior as impact. Do not edit/delete untrusted or old comments. Truncated required reads still refuse under current safeguards. Claims, readiness, impact labels and repository settings are untouched.

Existing v2 complexity markers and payloads remain valid; writer metadata was already enough to encode the assessment, so there is no marker/schema bump. A shared GitHub account proves that account's action under the trust rule, not which agent ran it. Preserve the reported estimator distinction in help and result explanations.

## Acceptance and rollout

Injected scanner/writer/reader tests cover trusted current record, confirmed-untrusted newest with older trusted record, unknown newest with older trusted record (must not fall back), unknown editor, bot/app treatment, incomplete/newest-missing history, cross-metric isolation, disabled metric, fresh rationale writes, matching trusted retry, spoofed retry, denied authenticated writer and partial label/comment outcomes. Verify unchanged label classification, known-size display with unknown provenance, paired-ranking inspection and CLI/MCP text/JSON parity. Permission lookup counts must stay bounded per distinct verified author/repository/run. No live writes, user configuration or signing operations in tests.

After this reviewed contract merges, #269 implements only this consistency change. It does not block impact recording already delivered in #245 or require redoing historical estimates. Existing stored history is re-evaluated on read against current permission evidence; do not batch rewrite comments.
