# Next steps are the default role view

Owner decision, 2026-11-14; issue #353. This contract changes presentation,
not ranking or permission to act. Implementation ships separately after review.

## Purpose

The designer and implementer screens should answer one question: what should I
do next? Background findings, repository statistics and evaluator information
distract from that answer and consume agent context. Keep a useful shortlist by
default; make broader context an explicit request.

This is one unified to-do list, not separate queues by activity. It blends PR
follow-up, complexity estimates, impact assessments, implementation, inspection
and other supported role activities in approximate priority. Each item identifies
the next activity, explains its placement, provides the appropriate action command
and links to further detail. Claim commands apply only to activities that require
a claim; assessment or inspection must not acquire a claim just to fit the layout.
The product's central value is selecting and ranking useful next activities.

The owner also proposed raising assessments because they are usually quick and
provide intelligence for downstream choices. Current policy already places them
above ordinary implementation, but below known easy wins. Evaluate whether to
raise them above known easy wins in a separate ranking-policy change with concrete
scenarios. This presentation contract does not silently change that ordering.

## Default text

For both roles and both engines, render the ranked next-action list, preserving
its existing limit, ordering, action-specific reasons and next commands. Keep a
short repository/role identifier to prevent confusion between projects. Say
`No next steps found` for an empty queue; an incomplete collection must not imply
that no work exists. Keep nonzero action omission counts.

Do not append background sections, broad issue/PR/finding totals, assessment
totals, generic workflow instructions, policy hashes or engine banners. Keep
material warnings needed to interpret the recommendations: offline/stale data,
incomplete evidence, failed configuration or evaluation, and unavailable identity
focus. State shared warnings once. Preserve inspection actions in the shortlist.

The default remains a bounded recommendation, not proof that omitted work is
unimportant. Text-budget omissions must identify a supported way to obtain more.

## Explicit context

Add CLI `--context` and MCP `context: true` to restore the expanded compact
presentation, including background, totals and evaluator metadata. This is
presentation only: it must not change selected actions, evidence collection or
authorization. Preserve explicit `--guide`, `--estimate`, `--issue`, `--full`,
dependency/PR intake and catch-up commands as requests for their documented
information. These do not implicitly enable unrelated background sections.

MCP text uses the same default and opt-in as CLI text. Preserve versioned JSON
and MCP structured response schemas and their existing data in this slice;
do not silently remove fields from machine-readable output. Bounded structured
results remain the separate #266 contract. Document this distinction in help.

## Relationship to concise rows

Issue #352 addresses redundant per-row metrics, tags and wording. This default
change can ship independently without inventing scores or rewriting rule reasons.
Both changes retain rule-derived explanations and detailed evidence on request.

## Validation

Test both roles, both engines, populated and empty queues, omissions, offline and
incomplete facts, explicit context and guide/estimate/detail requests. Assert that
default text lacks background/totals/banners, expanded context remains accessible,
and selected actions and structured results do not change. Verify CLI parsing,
MCP schema/transport parity and packaged CLI behavior.
