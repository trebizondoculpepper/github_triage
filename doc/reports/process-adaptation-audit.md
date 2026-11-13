# Mirrored process adaptation review

Documentation audit for #12, 2026-11-13. Compares `doc/process.md` and `doc/design-implementation.md` with current `AGENTS.md`, `CONTRIBUTING.md`, `doc/repository-settings.md` and merged contracts in `doc/design/`. This is a review of repository evidence, not a live reconfiguration or wholesale adoption of the source project's policy.

## Recommendation

Keep **AGENTS.md plus the focused merged contracts** as the active process. Reuse the mirror's useful principles already present there; do not activate the copied document as a second competing instruction source. Preserve `doc/poker-blocks-process.md` as the historical source snapshot. Link the adapted proposals to this assessment so agents do not accidentally follow obsolete steps.

The project already has the practical architecture it needs: evidence-first intake; one active contribution; reviewed design before changed architecture; focused implementation; current-head verification/review; explicit handoff/readiness. The remaining work is implementing those contracts in the tool and generating help from implemented policy (#71), rather than adding another prose gate.

## Evidence and disposition

| Mirrored element                                                            | Current project evidence                                                                | Disposition                                                                                                                                                   |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Research/design separated from production implementation                    | AGENTS architecture section; doc/design/README.md; owner assignments                    | Retain existing role boundaries; research is not reserved to one agent                                                                                        |
| Documentation before changed architecture; reuse accurate existing patterns | AGENTS “Architecture and scope”; doc/design-implementation.md                           | Already active; no mandatory fresh research or docs ceremony for conforming fixes                                                                             |
| Manual claim label/comment recipe                                           | Implemented claim and needs-human; doc/design/workflow.md                               | Prefer the tool; manual GitHub edits only when the operation is unsupported or evidence needs diagnosis                                                       |
| Ready-only pickup and simplified old prioritization                         | doc/design/briefings.md                                                                 | Superseded: incomplete work can be eligible; addressed attention/PR follow-up and explicit sorting retain their agreed semantics                              |
| Unqualified one-ticket/one-PR rule and close-after-merge instruction        | Separate design/implementation phases; #25/#71/#78 required reopening after docs merged | Keep contributions focused, but close a ticket only when its acceptance is complete. A docs phase does not finish implementation or an empirical study        |
| Never ask the owner in chat                                                 | Designer/owner workflow in doc/design/briefings.md; actual owner design sessions        | Do not adopt. Record durable questions on tickets and discuss them with the owner through the designer; one question at a time remains the owner's preference |
| Stale/takeover prose and agent-to-agent handoff                             | doc/design/workflow.md and diagnostics.md                                               | Activity is inspection evidence. Release makes work available even without a handoff; elapsed time alone never grants takeover                                |
| Direct gh search/dependency examples                                        | AGENTS triage-first rule; implemented deps add/remove                                   | Superseded by supported triage operations. Native edges remain authoritative                                                                                  |
| Abstract checks/review assumptions                                          | doc/repository-settings.md; implemented verify matrix and installed-archive checks      | Use documented actual gates, not inherited game assumptions; inspect current-head review evidence before merge                                                |
| Plain JavaScript precedent                                                  | doc/design/typescript.md, owner decision #91/#93                                        | Superseded: maintained first-party code is TypeScript, with deliberate documented ancillary-language integrations                                             |

The false-completion cases are an observed reason to distinguish contribution completion from ticket completion. This audit does not infer intent from who closed a ticket. They were reopened with explicit remaining work; it is not evidence that the underlying features or experiment were implemented.

## Small active workflow, without new governance machinery

Use triage to inspect complete evidence, native blockers and current ownership. Identify the applicable merged contract. Claim only work actually starting; preserve another agent's contribution. If evidence or a consequential decision is missing, record the concrete gap and keep independent work moving within assigned scope. Implementers follow the contract; designers clarify it rather than editing production code under a documentation assignment.

Review the focused deliverable against its declared acceptance and current head. A research report can conclude “simplify” or “not established”; it need not invent a positive result. A contribution can finish while a linked PR or ticket still needs follow-up. Release a contribution claim when done, preserve remaining blockers, and close only the acceptance actually satisfied. Do not silently adopt a new permission system, mandatory approval count or blanket human-contact prohibition.

Keep live settings and credentials separate from prose. The repository settings document records the configured gate; this audit did not change or independently revalidate those remote settings. The TypeScript decision, process-guide design and shared lifecycle contracts provide the current direction; the historical mirror is not authority over later owner decisions.

## Completion and future changes

This report completes the requested consideration of the mirrored process. It recommends selective reuse through existing active contracts rather than adopting the whole mirror. It introduces no new owner decision or delivery blocker. If the owner later wants a different governance rule, raise that concrete change in its own focused design ticket; do not reopen a general process-import exercise.

#71 can generate explanatory help from implemented policy. #91 enforces the source-language migration through type/build checks. Workflow features enforce lifecycle state transitions through code. None requires importing the old game's complete prose process or introducing another framework.
