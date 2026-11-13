# Proposed design and implementation responsibilities

**Status: proposal for [adaptation review #12](https://github.com/trebizondoculpepper/github_triage/issues/12).** Mirrors poker_blocks' `AGENTS.md` sections “Recorded decisions”, “Checks before committing”, “Code Review Rules” and “Design and implementation ownership”, plus its process guide, at main commit `2dec9d10e81a21a9dfaa60fe89ac081eadb0b84e`. The [source process snapshot](poker-blocks-process.md) is retained as historical context with private integration details removed. This document translates the responsibilities to the standalone CLI; it does not import game rules or claim configured bot reviews.

**Adaptation reviewed:** [the current-project audit](reports/process-adaptation-audit.md) recommends the active AGENTS/merged-contract process rather than wholesale adoption. This mirrored proposal is historical context; later owner decisions take precedence.

## Design owns initial decisions

The design agent works with the user on initial behavior and architecture decisions, updates canonical contracts and prepares implementation tickets. For this project those contracts are [the CLI design](github-triage-cli.md) and [native issue dependencies](issue-dependencies.md). Each ticket identifies the applicable already merged sections and acceptance criteria.

Research is a joint responsibility. Either designer or implementer can inspect source, reproduce behavior, probe an API or contribute evidence about a concrete uncertainty. Design ownership does not reserve research to one role.

## Implementation follows merged contracts

The implementing agent builds against agreed, already merged contracts. If implementation exposes a missing pattern, contradiction or consequential unresolved decision, report the concrete evidence on the ticket/PR for design review. Do not silently replace the architecture or bundle a changed architectural decision with runtime code.

The user may explicitly reassign roles or authorize a design change. The documentation-first merge order still applies. Straightforward reuse of an accurate documented pattern does not require a new research report or redundant design PR.

## Documentation first

New or changed behavior needs an accurate documented pattern describing ownership, configuration, lifecycle and composition. If the pattern is missing or changing, document it in its own PR and merge that before starting the corresponding implementation PR. Record the implementation ticket's native dependency on that design ticket.

Keep policy in registered workflow/rule/role handlers and declarative configuration rather than issue-number, named-agent or repository-specific branches. Shared command capabilities should be documented and composed once rather than implemented independently and extracted afterwards. Existing contracts remain subject to review: this process does not itself resolve output-schema, role or mutation-policy decisions.

A fix that only brings behavior into line with an accurate merged contract needs no document change; cite the section it now satisfies. Presentation-only or editorial changes do not automatically require a new architectural decision.

## Evidence supports decisions

Architecture documentation cites inspectable support: existing research, a source audit with file/symbol references, a reproducible experiment or authoritative API/library documentation. Explain how the evidence supports the decision, relevant alternatives/trade-offs and verification limits. Distinguish observations, proposals and assumptions.

Research is required where current behavior, reusable architecture or a library/API choice remains uncertain. It is not a mandatory separate mission for every change. Existing sufficient evidence can be reused.

## Review against the target contract

Review changed behavior against the agreed target architecture, rather than using neighboring transitional code as precedent. A finding identifies changed lines, the concrete inconsistency and the relevant contract. Do not demand speculative features, unrelated migrations or a fresh research report without a concrete unsupported claim.

Review both directions: implementation that introduces undocumented architectural changes, and documentation whose factual claims or recommendations lack support. Missing source/API evidence and missing documented ownership are different findings; say which is missing.

For this CLI, check read/mutation boundaries, injected gh calls, repository/agent opacity, native dependency authority, freshness/completeness, schema compatibility and safe offline/checkpoint behavior against the applicable contract. These are review lenses drawn from existing project documents, not authorization for unfinished mutation commands or live migration.

## Coordinate through tickets

The [proposed process](process.md) mirrors intake, claims, native dependencies, open questions, one-ticket/one-PR slicing, worktrees, continuous implementation/review and post-merge cleanup. High-cost decisions are asked on tickets; low-cost choices can be recorded as explicit assumptions consistent with existing contracts. Keep one active claim per agent and do not overwrite another contributor's changes.

Adoption review must decide how those agent autonomy rules fit external contributors and public fork CI, and reconcile the process with actual labels, required checks and reviewer integrations. Until that review is complete, follow the existing agent/contributor guide and explicit user instructions.
