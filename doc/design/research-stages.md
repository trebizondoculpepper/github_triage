# Proportionate research: plausibility before practicality

Owner decisions from 2026-11-13, covering #72/#74/#75/#78. These instructions separate the original narrow plausibility experiment from later evaluation. They do not introduce a new implementation gate or authorize repetitive paid runs.

## Initial plausibility work

Use up to roughly **one hour of agent time** for the initial thinking, preparation and small demonstration. A capable agent such as Codex or Claude may investigate or build an isolated research artifact within that limit. Keep production implementation separate from a designer/research assignment.

The question is “is there a plausible basis for pursuing this idea?” A bounded example, a small working mechanism and an honest account of limitations can answer it. Do not demand exhaustive coverage, statistical confidence, production readiness or proof of long-term practicality to accept this first stage. The existing rules spike is evidence about its demonstrated slice, not proof of every workflow case or agent adherence.

Stop with a clear outcome: plausible enough to continue, not plausible on current evidence, or unresolved within the limit. State what was demonstrated, what was not, time spent and a recommended next step. The time limit is a cap, not a requirement to use the full hour. Negative or inconclusive findings are valid outcomes.

## Later feasibility and repetitive evaluation

A higher-standard study of true feasibility, practicality, effectiveness or cost is separate work. **It must not block completion of the original plausibility experiment.** Preserve this separation in ticket dependencies, acceptance criteria and briefing guidance.

After reviewing plausibility, prepare a reproducible handoff for a cheaper agent to perform repetitive trials. The handoff identifies model/harness, fixtures, exact prompt variants, fixed settings, scoring, repetition count, stop conditions, data to retain and known limitations. A possible **$20 cap** for that experimental phase is for later agreement; it is not current spending authorization. Do not start repetitive paid calls merely because the initial agent-time phase is authorized.

The rules-versus-reasons protocol in `doc/reports/agent-rule-guidance-evaluation.md` remains the design for that comparison. Its trial counts are proposals for later evaluation, not prerequisites for the original rules-language demonstration. Do not report protocol preparation as completed empirical research.

## Decision rule: evidence should scale with cost

This is also a candidate example for the reasoning system, expressed in plain language rather than prescribing production rule syntax:

| Known facts                                                      | Appropriate next action                                | Reason                                                                 |
| ---------------------------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- |
| Initial experiment is cheap, bounded and within authorized scope | A small plausibility experiment is reasonable          | Its purpose is to obtain the evidence not yet available                |
| Experiment is costly and basic plausibility has evidence         | Consider a separately scoped and budgeted evaluation   | Prior evidence can justify investing more, subject to permission       |
| Experiment is costly and plausibility is missing                 | Seek cheaper plausibility evidence first               | Avoid committing substantial resources before a plausible basis exists |
| Cost is unknown                                                  | Estimate or bound it before classifying the experiment | Unknown cost must not silently become “cheap”                          |

Do not make cheap plausibility work depend on the expensive validation that it is supposed to justify. Conversely, plausibility does not prove practical usefulness or grant permission to spend. Cost includes money, agent time, setup, operational exposure and opportunity cost; no universal numerical high/low threshold is introduced here.

This example is a future scenario for #72/#75, not an added feature requirement that #74 must implement retroactively. Keep reasons and observed facts visible so an agent can understand why a small experiment is appropriate or why escalation is needed.

## Worker handoff

No further owner decision is needed for the immediate migration or bounded plausibility stage. The urgent TypeScript migration follows the relaxed helper-script policy and current-LTS guidance. Resolve its merge conflicts and run current-head checks; then rebase queued feature PRs. These are worker actions, not reasons to repeatedly ask the owner to restate the policy.

Platform-restricted research still goes to the named platform's agent, and unresolved upstream identity interoperability remains an engineering prerequisite. Later repetitive evaluation waits for its own reviewed handoff and budget. Nothing here overrides an active claim, grants new production authority or installs a live watcher/configuration.
