# Datalog live-queue acceptance

Date: 2026-11-14. Mission #326; installed acceptance #306. Harness: Codex coding-agent session on macOS arm64; Node v26.7.0, npm 11.19.0. Model identity was not independently queried. No paid model trials were run.

## Result

The actual Datalog implementation produces concise, matched-rule reasons and usable next-action queues from live GitHub evidence. Installed archive tests prove CLI/MCP parity for implementer and designer, both impact and age ordering, plus explicit TypeScript rollback. The owner preferred Datalog explanations and explicitly approved its default adoption and foreground inspection policy.

This is bounded acceptance, not evidence that Datalog universally chooses better priorities or improves agent adherence. Both engines continue to depend on assessment quality. A stale impact rationale can still overstate the benefit of work remaining.

## Same frozen facts, both engines

The fresh collection contains **52 open issues and 2 open PRs**, collected at **2026-11-14T15:07:47.864Z** from the final canonical repository. The source revision was `806f54a8839e77e23f46da62963c5fc5231c4bb8`; evaluator policy version 1, rules hash `009eccc169aa4a059b8153d9d743df13b6bc64b8c8953da5e67d1006c8cf3ec1`. The live Datalog read used 1,858 normalized datoms, reported complete collection and no evaluator diagnostics.

A single paired assessment map, read with cached current author-permission checks, was supplied to both evaluators. No TypeScript ranking or eligibility output was passed into Datalog. Raw snapshots and full outputs remain outside Git.

| Role        | TypeScript actions | Datalog actions | Shared actions | Shared relative order | Same top ten |
| ----------- | -----------------: | --------------: | -------------: | --------------------- | ------------ |
| Implementer |                 15 |              16 |             13 | Yes                   | No           |
| Designer    |                 40 |              43 |             40 | Yes                   | Yes          |

Datalog adds inspection actions for #23, #252 and #254 because their allowed platforms are known but the viewer platform is unknown. The owner confirmed that surfacing these inspections is desirable. They remain **inspection**, never permission to implement. TypeScript additionally lists blocked-work inspections for #20 and #306; these are not Datalog implementation recommendations either. Thus the queues are not identical even though their shared actions retain the same ordering.

The earlier 43-ticket run had an identical implementer top ten. That was a different frozen collection; the current results above supersede any implication of universal top-ten parity.

## Example explanations

- Implement #291: `Known easy win: impact L, complexity S.` The fired rule is `D-EASY`, with current assessment bindings and separate eligibility evidence.
- Assess impact for #309: `Complexity S is small, but benefit is unassessed; assess impact to test for an easy win.` This makes the information-gathering purpose explicit.
- Inspect #23: `Eligibility is unproven: inspect incomplete evidence or state the required platform.` Its matched facts explicitly identify `viewer platform unknown`; the separate denial is `D-DENY-PLATFORM`.

TypeScript often exposed eligibility descriptions or reason tags for assessment rows, such as `assessment, cross-role-boost, impact-current, complexity-unassessed`. Datalog instead explains the selected action itself. This is a qualitative clarity judgment, not a blinded study.

## Safety and limits

The evaluator is read-only. Claims, merges, completion and other mutations retain their existing fresh-evidence enforcement. Missing evidence is never permission. The normal default is Datalog; an omitted role is a truthfully reported implementer presentation default, not inferred identity or authority. Explicit role and engine settings win. TypeScript rollback remains available.

The 500-subject/50,000-datom scope limits, cancellation checkpoints and soft two-second diagnostic remain visible. Installed tests cover both default and rollback without requiring development dependencies in the installed package. The archive includes the lazy evaluator chunk and DataScript license/source notices.

The repository was renamed during this work. Existing delivery receipts bound to the old repository name may fail the unchanged binding validation; this trial does not rewrite receipts, weaken validation or treat a mismatch as completion. Repository-identity migration is tracked separately. Other unrenamed repositories are unaffected by that specific mismatch.

## Reproduce

Run from a verified checkout using the supported CLI/cache boundary:

```sh
node dist/cli.mjs --repo OWNER/REPOSITORY --role implementer --agent NAME \
  --cache /tmp/datalog-trial-snapshot.json --json --no-update-check \
  > /tmp/datalog-live-queue.json
npx tsx scripts/datalog-trial.ts --repo OWNER/REPOSITORY \
  --snapshot /tmp/datalog-trial-snapshot.json --agent NAME \
  --out /tmp/datalog-comparison.json
npm run package-test
```

The maintained TypeScript helper compares both roles from one snapshot and one assessment map, with current read-only provenance-author permission checks through authenticated `gh`. It does not change configuration or GitHub. Add `--platform PLATFORM` to both collection and comparison when testing a known platform. A new capture naturally differs from the historical input above.

## Global source installation

After clean current-head review and required CI, the foundation (#333) and default (#334) were merged. The verified source **`720dd7c87c362e950ef6f5b46e54fa136578616e`** passed checks, all **839 tests**, build and CLI help, was packed, and that exact archive was installed globally. Archive SHA-256: `effbb15da536d08e7ac4f46dbb3e2025bcfcb6044d164ec5612b903363939300`.

At this acceptance point, the executable names were `/opt/homebrew/bin/github-triage` and `/opt/homebrew/bin/github-triage-mcp`. The source-checkout package version is `0.1.0`; this was a **local source installation, not an npm publication**. The coordinated PDB naming/package release is a separate transition.

Using the globally installed executable against the same frozen canonical-repository cache proved:

- No explicit role: `decisionEngine.used=datalog`, effective role `implementer`, role source `default`, ten action rows.
- Explicit designer role: `decisionEngine.used=datalog`, effective role `designer`, role source `request`, ten action rows.
- A throwaway verified repository configured through `config set briefing.engine typescript` returned `used=typescript`, source `config`. The temporary repository/settings were removed; no live repository engine setting was overwritten.
- The global MCP executable completed a real stdio handshake and listed its four `triage_*` tools. Installed archive tests separately exercised actual CLI/MCP role and order parity with controlled inputs.

Offline global verification truthfully reports unavailable live provenance authority; it does not treat cached permission evidence as fresh. The earlier live comparison used one current permission boundary for both engines. Rollback remains `github-triage config set briefing.engine typescript` at this pre-branding acceptance point; the renamed release updates the executable prefix while preserving the setting.
