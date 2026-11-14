# Local service and isolated rule testing

Owner decisions, 2026-11-14. This records agreed direction and delivery boundaries;
it does not claim the service, transports or test reporting are implemented.

## Local service sequence

The first product entry point is `pdb serve`, a locally installed Node/npm command.
Docker was considered and explicitly deferred. Reuse the host's authenticated `gh`
boundary; do not add credential copying, container authentication or a new login
service to this slice.

The process stays running, but its collected state does not survive restart. Cache
whole collected results in memory with a five-minute initial TTL, configurable
toward ten minutes. Do not add a database, persisted snapshot cache or independent
page cache. Coalesce simultaneous reads and isolate repository, authentication
context and evidence coverage. Derive each caller's role/identity view correctly;
one agent's rendered queue is not a cache entry suitable for every agent.

Show freshness, failures and explicit refresh. TTL expiry does not make volatile
facts safe for mutation: claims, completion and other writes retain fresh checks.
Design local binding, ports, shutdown and bounded resource use in #372. A mandatory
inactivity lease is not required for the first delivery.

Sequence the existing #42 work as follows:

1. #372: bounded service architecture/configuration contract.
2. #373: local service and shared memory caching.
3. #374: minimal project selector and designer/implementer next-step views.
4. #390: common HTTP MCP transport over the same service, retaining stdio.
5. #391: connection configuration and agent-usage prompts on a setup page.
6. #392: readable English policy generated from the active rule artifact.

HTTP MCP may proceed as soon as the service contract and implementation support it;
it does not wait for a polished dashboard. The English-policy page may proceed in
parallel once its service and native-artifact prerequisites are available. Generic
HTTP MCP takes priority over platform-specific continuation implementations.

Use the same ranking and explanations in web and agent views: minimal header,
one approximately prioritized activity list, appropriate action commands and
detail links. Keep broader context opt-in. The setup page reuses #350/#351; it does
not silently change project guidance or agent configuration. The policy page
describes applicable rules and their reasons; individual recommendations show
which rules actually matched. Do not invent a general semantic translator.

## Client acceptance and continuation

Codex, Claude Code and native Ori Code are the initial clients. Only an agent
actually running in the named platform may claim its platform-specific task.
Installed executables or the same underlying model do not satisfy this gate.
Record actual harness/version/model provenance, distinguishing Ori Code from an
Ori launcher wrapping a different client.

HTTP MCP native acceptance is #395, #397 and #399. Stop-hook research is #386,
#387 and #388; prototype/reuse validation follows in #396, #398 and #400.
Research can establish hook semantics before HTTP is available, but end-to-end
HTTP tests depend on #390. Prefer an existing shared hook rather than separate
copies. Identify a shared core and thin adapter contract if hooks differ.

The desired natural-stop behavior is: request a fresh briefing for the current
repository, identity and role, deliver it as instructions, and continue useful
work through the normal claim/validation flow. Executing a script, starting a
turn, receiving a notification and actually receiving that briefing are distinct
observations. Test empty/unchanged queues, reentry, unavailable service and explicit
user interruption. User stop wins. A replacement session is not proof of continuing
the original. Do not create an endless work loop or install production hooks as a
side effect of the bounded research/prototype.

## Native policy sources and tests

#348 is the owner's priority within source reorganization. Keep the current
DataScript engine and its native EDN syntax under `src/rules/datalog/`, including
rules, queries and coherent explanation/ordering metadata. JetBrains support is
useful to investigate, but lack of a plugin does not justify translating policy
to Prolog syntax or changing engines.

Build the internal rules component independently, with a deterministic typed
facts-in/decisions-and-explanations-out boundary. The build validates/parses and
bundles native sources; describe precisely what is compiled rather than claiming
unsupported ahead-of-time compilation. Keep one npm package and package all needed
runtime artifacts. Host collection, authentication, rendering and configuration
remain outside the pure rules component.

Write rule test definitions in native EDN: synthetic facts, queries/assertions and
expected decisions. A dedicated rules-only command must run without starting PDB,
GitHub collection or general application tests. #336 investigates a compatible
existing framework first. If none fits, a small TypeScript runner may execute the
native definitions; document the choice honestly. #339 and #340 inform boundary
tests and coverage without making this an unbounded testing-platform project.

Report distinct outcomes:

- Rule failure: a valid scenario executes but its decision, denial, order or
  explanation bindings differ from the expectation.
- Infrastructure/framework error: parsing, source loading, configuration or runner
  execution fails, so the intended assertion was not validly evaluated.
- Host integration failure: adaptation or application consumption is wrong; keep
  these tests separate from the native policy suite.

Preserve scenario/rule IDs and native source locations. If assertions fail and an
infrastructure error also occurs, report both rather than replacing one category
with the other. A crash or missing report must never look like a passing suite.

## GitHub test visibility

#393 improves reporting for all tests, including existing application tests.
#394 applies that shared reporting path to isolated native rule tests. Start with
a small validation spike against the exact Vite+/Vitest version: intentionally
fail a disposable test and verify the actual GitHub summary, annotations and source
location. Prefer built-in reporters, then evaluate a maintained reporting action
only if needed. Check fork/read-only permission behavior without privileged
execution of untrusted artifacts.

Suites may write separate JUnit XML/structured files and aggregate them into one
visible summary. Preserve suite, platform, stable test name and bounded expected/
actual details. Upload available reports even after failure; distinguish absent
reports and reporting errors. Preserve existing test exit codes and required
`verify` semantics. Local and CI rules-only execution use the same assertions.

## Other settled decisions

#378 retains assessment priority above continuing medium-impact/medium-complexity
claimed implementation: improving project understanding is a valid borderline
trade-off. Existing claims stay intact and PR follow-up remains important.

#379 truncates oversized text and explicitly reports truncation due to maximum
size, rather than adding a normal minimum-size rejection. Reserve notice space;
define a bounded shortened indicator for a limit smaller than the notice itself.
Default responses should already be short, with additional detail available through
focused calls. Do not misrepresent a truncated response as exhaustive.

#377: a draft PR alone is progress, not an immediate-action signal or completion.
Show a concrete independent next action when one exists. Work remains the agent's
responsibility and on its to-do until its definition of done is met, including
truthfully labeled waiting states that allow other work. Add a regression proving
that creating/attaching a draft never authorizes completion. Human closure remains
authoritative. The separate BEHIND/unaccepted and truncated-review questions were
not expressly settled here and must not be reported as owner-approved decisions.

#380 permits up to three pages per source in the bounded read experiment, reporting
incomplete coverage when necessary. It does not authorize write-enabled experiments
or settle adoption of the proposed production reconciliation policy. The owner
rejected independent page caching in favor of the simple short-lived memory cache.
