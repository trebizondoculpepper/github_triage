# Workflow help and compact process guide

Contract for #71. Documentation-first design; no guide command or configuration reader is shipped by this document. The lifecycle and ranking contracts in this directory remain normative. The formal-language research #72–#78 is independent: start with ordinary registered TypeScript policy metadata, not a new rules engine dependency.

## Objective and scope

An agent should understand the applicable workflow and next valid operation from one tool result. Generate concise guidance from the same implemented policy and command metadata used by the CLI. Do not maintain an independent prose checklist of state transitions or print planned command syntax as executable recovery advice.

This is explanation, not a new authority model. It does not enable automatic claim release, merge, migration, publishing or owner impersonation. The guide cannot decide that an unknown prerequisite is satisfied. Per-row evidence and actionable refusal messages remain required even when the recurring guide is disabled.

## Reconcile the original proposal

Use `briefings.md` and `workflow.md`, not superseded ticket wording:

- Addressed attention first; PR follow-up and owned work before general pickup. Default pickup uses urgency then immediate otherwise-ready unlocks. No separate importance scale or automatic bug-first override.
- Incomplete/parked means partial work and is eligible when other prerequisites hold. Deliberately deferred features are different. Do not print “never pick parked work.”
- Stale claims are inspection candidates, never permission for automatic takeover. One active claim means current work; release before switching. Attention does not reserve work.
- Explicit oldest/newest replaces pickup weights while retaining metadata and eligibility. A done contribution can still have PR follow-up.
- Questions go on the relevant ticket; designer/owner discussion remains valid. Do not prohibit the human conversations this project exists to support.
- Platform restrictions apply to matching named harnesses, not a blanket ban on all platform-labelled research.

When installed behavior has not yet caught up with a merged contract, clearly distinguish implemented behavior from the planned feature. Only implemented commands appear in executable examples. A gap notice can link to the relevant local contract; it must not claim that printing guidance implements lifecycle enforcement. #71 need not bundle #2/#45/#62 or the formal-language experiment.

## Surfaces and output budget

`--help` has a short permanent Workflow section and a pointer to `pdb process`. It remains local and credential-free. Disabling the recurring guide never removes on-demand help.

`pdb process` renders the full available guide without querying GitHub. It supports the same role identifiers/default resolution as #1 when those are implemented; do not invent a competing role vocabulary or imply role grants permission. Until role selection ships, return the shared guide and state the limitation.

As updated by [the Datalog live-experiment contract](datalog-live-experiment.md), ordinary compact briefings omit the guide by default. `--guide` or an explicit true `processGuide` setting enables it; JSON retains the structured `process` object. Use a maximum **900 Unicode code points** for guide text including its pointer; aim below the limit rather than padding to 600. Preserve actionable findings and their evidence before optional guide expansion. Under a smaller global output budget, emit only the pointer and report guide omission explicitly. Never truncate inside a command or silently drop a condition that changes its meaning.

When disabled, emit a one-line pointer with policy version instead of the guide body. The opt-out is therefore not silent: that pointer, any configuration diagnostics and, when enabled, the omission notice are a required footer whose space is reserved before evidence rows are allocated, so text output never exceeds `--max-chars` beyond the irreducible header and footer. `--guide` enables and `--no-guide` disables for one invocation. Conflicting flags are an argument error with exact valid alternatives. Full `process` and `--help` output remain available regardless of recurring-guide settings. No automatic checkpoint/version suppression in this first slice: a project can opt out explicitly; smarter suppression is a future refinement.

## Minimal project configuration

Implementation note (#71): the repository configuration service from #114/#116 landed after this contract, so the setting is the registered `processGuide` boolean key in `.github/triage.json`, set with `pdb config set processGuide false`, rather than a separate `.pdb.json`. Semantics below are unchanged; unknown keys in that shared file are refused by the service, so the briefing falls back to the default with a diagnostic rather than a warning.

Use a committed `.pdb.json` at the invoking Git project's worktree root:

```json
{ "schemaVersion": 1, "processGuide": false }
```

Absent file or absent `processGuide` means disabled. Precedence: explicit CLI flag, valid project setting, disabled default. No home-directory setting, parent-directory search beyond the resolved project root, network configuration or unrelated local configuration modification. This file holds project presentation policy, never identity or secrets. Do not create or edit it automatically.

`--repo owner/repo` selects GitHub data, not an arbitrary local configuration path. Use local project configuration only when its resolved origin matches the requested repository; otherwise report that no matching local project setting was applied and use the default/CLI override. A non-Git working directory likewise uses the default. Do not guess configuration from another checkout or fetch a remote policy file implicitly.

Validate a present file as JSON object with supported schema and boolean `processGuide`. Malformed/unsupported configuration is a concise diagnostic naming path and valid shape; continue the read-only briefing with the disabled default and report fallback, without treating configuration problems as incomplete GitHub evidence. Unknown keys receive a warning rather than silently pretending they changed behavior. Never echo entire configuration contents. A CLI override still works when configuration is invalid. Plain `--help` does not require configuration to load successfully.

## Shared metadata and JSON compatibility

Add optional process metadata to the existing versioned briefing schema, preserving existing required fields. The process object records its own `schemaVersion`, `policyVersion`, enabled state, selection source, implemented scope/limitations, stable rule IDs, guide text or null, omission reason and on-demand command. Disabled output retains the pointer/version but does not serialize the full guide in hidden fields. JSON stdout stays valid; diagnostics follow the existing structured-warning/stderr convention.

Compute `policyVersion` as a deterministic hash of canonical guidance-bearing policy/command metadata: stable IDs, semantic parameters, explanations and capability state. Exclude issue snapshots, clocks, credentials and formatting-only changes. Sort canonical keys. Hashes identify content; they do not prove approval or authority. Optional project wording is deferred: do not fetch linked docs or hash arbitrary prose in this slice.

Register explanations alongside rule definitions and supported command schemas. Text/JSON/full/compact renderers consume that source. Expose measured `guideCodePoints` and UTF-8 `guideBytes` additively in output metrics; do not call byte counts exact model tokens. Stable command templates use actual known ticket/agent values and clearly marked placeholders for judgment-dependent content. Never invent a handoff reason or execute a suggested command.

## Acceptance and handoff

Use injected local filesystem, project/origin resolution and command metadata. Verify default, opt-out, override, conflicting flags, malformed file, unknown schema/key, no project and explicit remote-repository mismatch. Assert JSON validity, bounded guide/pointer, omission metrics and no credentials/network needed by help/process. A disabled guide must preserve evidence, refusals and recovery syntax. A policy semantic change updates version and all renderings together; presentation-only changes do not. Unsupported commands must never appear as ready-to-run actions.

Implement #71 in a focused PR after this contract merges. Reuse registered policy rather than copying labels or creating a production DSL. Keep lifecycle mutations, role selection, checkpoint suppression, linked-doc customization and generalized global settings in their own delivery scopes. No additional owner decision is needed for this first slice; these technical defaults are explicit and reviewable here.
