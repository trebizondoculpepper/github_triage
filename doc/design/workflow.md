# Claims, questions and handoff

Contract for #2/#3 and separately delivered #62. Planned commands below are interface contracts, not claims that they are available today. Help/recovery suggestions must be generated from the implemented command registry.

## One active contribution

A claim means “I am working on this now,” not reserving future work. One active claim per agent. Claiming requires fresh open/eligibility/owner checks. Never steal another agent’s claim. Reject competing or ambiguous ownership and explain exact alternatives. A claim is an `agent:NAME` label with a source-linked explanatory comment and optional branch; attention/origin do not imply claims.

`claim N --agent NAME [--branch BRANCH]` refuses when that agent has another active claim, identifying it and offering explicit disposition commands. Switching is release/handoff followed by claim; partial failure must never leave two active claims. No claim is acquired until the previous claim is observably released. Concurrency limits of GitHub label edits must be reported honestly; recheck and surface conflicts rather than advertise atomic locking across clients.

## Focused handoff (#62)

Use `release N --agent NAME --as ready|incomplete|done [--note TEXT] [--pr URL|--change URL]` as the shared handoff transition. Ready is untouched/released work; incomplete means partially worked (parked is a synonym), available for pickup subject to other prerequisites. A handoff note is expected, but absence must not prevent release or subsequent pickup. Do not create a replacement ticket or hide incomplete work as deliberate deferral.

Done ends the agent’s contribution/claim, not the issue or PR. Prefer a PR link; a direct-main change set is an accepted, less-preferred alternative. If an open PR exists, use `status:awaiting-review` and exclude implementation pickup. A PR whose state cannot be verified is reported unknown, not guessed merged. A done contribution without an open PR is reported as contribution-done for inspection, not silently returned to pickup or closed; the exact existing project label mapping can be configured without changing this invariant.

Post the supplied outcome/evidence and perform the intended claim/readiness updates with fresh-state validation. Report per-step success/failure and exact retry guidance. Preserve unrelated blockers, attention and other owners. A failed comment must be visible, but cannot retroactively make already released work unpickable. Retry recognizes its own operation identity and avoids duplicate handoff comments; changed external state requires re-evaluation. This bounded operation does not import deferred migration machinery.

Review rework requests the contributor’s attention. They explicitly reclaim when starting fixes, resolving any other active claim first; return to awaiting review and release when finished. No automatic reclaim from a reviewer comment.

## Human questions

`needs-human N --agent NAME --designer NAME --why TEXT --question TEXT [--question TEXT...]` records the questions/reason, marks design/decision-needed as appropriate, releases only the caller’s claim, and addresses the named designer. The designer discusses with the owner and can answer “what needs my attention?” Do not require the owner to monitor GitHub. Multiple designers coordinate among themselves; no election or automatic destination guess. Provide explicit selection if routing is ambiguous.

Any participating agent can judge a question resolved and update the relevant marker/readiness; another can restore the blocker with a concrete unresolved point. Partial answers are allowed. Recording answers and notifying the originator is desirable, but the extra bundled answer-recording convenience operation is deferred #63. Do not implement that new operation in #2. Other independently recorded questions/blockers survive a resolution.

## Actionable refusals

Every refusal includes stable error ID, current facts, failed prerequisite, supported recovery commands and retry syntax. Required human/agent judgment is a clearly marked placeholder, not invented content. Already-owned ticket: show existing claim and release alternatives. Blocked ticket: show blocker and intake/alternative-work command. Other owner: name ownership and show alternative work, not a takeover command. Missing evidence: give refresh/inspection guidance. Use text/JSON equivalents; stdout/protocol stays valid. Never perform an unsolicited disposition to make a requested command succeed.
