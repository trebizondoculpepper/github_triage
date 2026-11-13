# Design handoff: agent-first triage

Status: owner-confirmed direction consolidated on 2026-11-13; implementation contracts take effect after this documentation PR merges. These documents describe proposed behavior, not features already shipped. They supersede conflicting historical paragraphs and older ticket proposals **for the features below**, without adopting the proposed project process wholesale (#12).

The tool reduces GitHub searching and encodes agreed lifecycle prerequisites and mechanical updates in code. Agents retain semantic judgment and existing authority. One human objective should normally require one tool operation, even when several bounded API requests happen internally. Help and errors explain the process and provide valid next commands; they must not require a documentation hunt.

| Contract                                     | Delivery tickets                    |
| -------------------------------------------- | ----------------------------------- |
| [Briefings and ranking](briefings.md)        | #1, #40, #43, #45; team context #41 |
| [Claims and handoff](workflow.md)            | #2, #3, #62                         |
| [Diagnosis and doctors](diagnostics.md)      | #41, #59–#61, #64, #66–#67          |
| [Update notifications](updates.md)           | #51 then #65                        |
| [Workflow guide and help](workflow-guide.md) | #71                                 |
| [Identity compatibility](identity.md)        | #3, #38; MCP #25                    |

## Handoff and sequencing

#14 owns this consolidation, not a giant implementation. Implement each delivery ticket separately against its applicable section; reuse shared collectors, fact records, command/rule/role registries and eligibility policy. No repository, named-agent or issue-number special cases. Preserve existing schema compatibility or version any incompatible result contract explicitly. Every result states repository, observation window, completeness, evidence and omissions. Unknown is not clean, eligible, answered or approved.

Ready after contract merge: ranking/role views (#1/#40/#43/#45), PR diagnosis (#59), review-cycle analysis (#60), explicit-evidence team/ownership views (#41/#61), basic update check (#51), and read-only Ticket Doctor (#66). Follow-ups: #65 after #51; #67 after #66. New mutation operations #2/#62 need their focused transition/API implementation plan against the workflow contract. Local setup #70 and automatic MCP identity are **not ready**: the inspected Agent Inbox writer drops triage_role (see identity contract and #69). Doctor can diagnose that limitation without silently repairing it.

Deferred by the owner: automatic migration apply/recovery #48, answer-recording convenience operation #63, and shared backend/SQLite/dashboard #42. They are not blockers for ordinary CLI/MCP. MCP #25 follows its focused [read-only interface contract](mcp.md); explicit project/identity and verified read-only lookup do not require enabling shared identity writes; platform wake-up adapters follow their research. Do not mark these ready just because product direction exists.

## Common validation

Use injected GitHub, clock, environment and filesystem boundaries. Assert meaningful user outcomes, not implementation mirrors. Verify stable ordering, bounded output, no credential leakage, missing evidence, current-head review freshness, and recovery-command validity. Diagnostics and briefings are read-only. Mutation results enumerate applied/skipped/failed operations; a single user operation does not promise a GitHub transaction. Do not install hooks, publish packages, change live identity files or run migrations while implementing documentation.

## Source language

**Prefer TypeScript and avoid handwritten JavaScript in application code.** Helpers in `scripts/` may intentionally use JavaScript, shell, batch, PowerShell or Python with justification and runtime/platform requirements documented. Ancillary languages such as Datalog may be added through an intentional architectural decision documenting why they belong in the project. Generated JavaScript for runtime compatibility is a build artifact, not the preferred maintained source.

The owner chose a full [TypeScript migration](typescript.md) in #91. This supersedes earlier plain-JavaScript design preferences, including MCP. Current runtime source remains JavaScript until that focused implementation lands; published bundles remain JavaScript for Node compatibility.

## Optional event production

[Polling and domain events](polling-events.md) (#32) follow baseline MCP. The opt-in 30-minute, process-local watcher does not require host wake-up adapters or the deferred shared daemon/SQLite design.

## Runtime baseline

The owner accepts a recent Node requirement: [the current Node LTS](runtime.md), tracked in #108. Older-Node compatibility no longer constrains the urgent TypeScript migration. Package engines, current user requirements and CI are updated by implementation; npm/npx does not supply or upgrade Node automatically.

## Research stage and budget instructions

[Proportionate research](research-stages.md) separates a roughly one-hour initial plausibility stage from later higher-standard feasibility/repetitive evaluation. The later study must not block the original experiment. A future cheaper-agent experiment budget requires separate agreement.
