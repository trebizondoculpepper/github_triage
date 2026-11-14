# Baseline MCP interface

Contract for #25, informed by #19 and identity investigation #69. This is a documentation-first read-only adapter; no MCP runtime is shipped by this document. Polling #32, wake-up adapters #26–#29 and shared backend #42 are independent follow-ups.

## SDK and architecture

Follow the [project language policy](typescript.md): prefer TypeScript, avoid handwritten JavaScript, and use ancillary languages such as Datalog only through an intentional documented architecture decision. This applies to MCP implementation and shared application services as well as the CLI; standalone helpers follow the script-directory policy.

Use the official **`@modelcontextprotocol/server` v2** and Zod v4 with TypeScript source, emitted ESM targeting the selected current Node LTS (owner language decision #91; recent-runtime policy #108). On 2026-11-13, `npm view @modelcontextprotocol/server version engines dependencies --json` reports 2.4.0, Node >=20, core 2.4.0 and Zod ^4.2.0. The [official tool documentation](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html) provides registration and validated input/output schemas; [stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html) provides `serveStdio(factory)` and protocol negotiation. Pin the reviewed dependency selection through the lockfile; recheck API/engines at implementation rather than invent framing or adopt a framework.

Create a transport-neutral read service around existing collection, dependency and presentation functions, with injected GitHub/clock/project/filesystem boundaries. CLI and MCP call it directly; do not invoke the CLI in a subprocess or parse terminal text. Reuse authenticated `gh` via the existing argument-array runner. No new credential store or token arguments. Keep mutation imports/routes separate and unavailable through this tool registry.

## Bounded-response replacement

The owner-approved replacement for oversized full structured results is [mcp-bounded-results.md](mcp-bounded-results.md), tracked in #266. Its reviewed versioned response contract supersedes the full-intake defaults below when implemented. Claude Code acceptance remains conditional pending default-settings retest.

## Three discoverable tools

All inputs are strict objects: unknown properties fail validation. Shared optional `repo` follows the existing owner/name validator. Positive issue numbers are safe integers. `agent` is a persistent name used for read presentation, not authentication. Validate dates with the existing ISO-with-time semantics. Defaults and bounds below are public MCP argument constraints, not silent truncation of source evidence.

| Tool                  | Inputs                                                                                                      | Result                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `triage_briefing`     | `repo?`, `agent?`, `since?`, `limit?` integer 1–100 default 5, `maxChars?` integer 1000–40000 default 10000 | Existing compact briefing JSON plus compact evidence-linked text                                         |
| `triage_issue`        | `number` required, `repo?`, `agent?`, `maxChars?` same bounds/default                                       | Full existing issue intake/history/dependency evidence as JSON; concise text with detail/omission notice |
| `triage_dependencies` | `number` required, `repo?`, `tree?` boolean default false                                                   | Existing native dependency JSON and concise dependency text                                              |

Use short descriptions explaining when to call each tool. All advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`; annotations are hints, not access controls. Remote evidence may change between identical calls.

Do not add mutation tools, generic shell/GitHub request tools, arbitrary URLs, file paths, cache/checkpoint writes, offline loading, migrations or team view to this baseline; role and order arguments are added only as specified under Role views (#260) below. Newly shipped CLI capabilities are not automatically new MCP tools. `since` supports owner catch-up without persisting hidden per-agent checkpoints. Dedicated role views follow #1; the baseline must not claim to compute an unimplemented owner/designer policy.

## Selection and identity

Startup accepts explicit `--project PATH`, `--repo owner/name`, `--agent NAME`, `--harness KEY` and `--entry KEY`; these are adapter options to be implemented, not existing CLI flags. `--project` supplies a configured local project default; it is not a per-tool arbitrary filesystem-read option. Keep current CLI argument behavior unchanged.

For each call: explicit tool repo wins over server repo default. Without either, use one applicable client root, then the configured project default and the normal local repository resolver. Normalize roots as local file URLs and verify their project relationship. Multiple applicable projects, non-local roots and an unresolvable target produce selection guidance, not an arbitrary first project or Ori daemon cwd. Only request roots if advertised; initialization must not require unsupported client capabilities.

Clarification for #271/#256: a Git checkout found at the server process cwd is not evidence that the caller selected that checkout. A multi-project host may start all servers in its daemon directory. Until optional roots are implemented and verified, a request without tool repo, startup --repo or configured --project returns repository-unresolved selection guidance. Do not call the cwd repository resolver with an absent project, even when cwd is a valid GitHub checkout. This applies consistently to all hosts; do not add named-client exceptions. CLI cwd resolution is unchanged because its invocation context is an explicit CLI workspace, not a shared MCP daemon context.

Once #256 is designed and delivered, one applicable verified client root can supply the repository at the existing precedence position above; it is a project-selection source, not authentication or permission authority. Verify local file URL, Git working-tree relationship and unambiguous repository resolution; do not follow an arbitrary first root. Missing, multiple, inaccessible or unrelated roots retain explicit-selection guidance and do not fall back to process cwd. Re-resolve on a roots change and do not reuse one connection's project/identity in another. Configured explicit selection remains usable without roots support; the SDK's advertised/negotiated capability is checked before requesting it. This clarification does not implement roots, make #256 a prerequisite for #271, or claim its downstream acceptance complete.

Recovery examples: configure the server with --project /absolute/checkout or --repo owner/name, or pass repo in the individual tool call. Explain that older cwd-only registrations need explicit configuration. Never silently select the host daemon's repository. Regression tests must cover a valid but wrong daemon checkout, no configured project, explicit tool/startup overrides, a configured project and unsupported roots. Polling startup has its own selection path and must enforce this boundary independently: --poll requires startup --repo or explicit --project. A per-tool repo does not bind a process-wide watcher. If neither startup target exists, refuse the requested polling startup with configuration guidance and no watcher, timer or collection; never call currentRepository(undefined). Rerunning without --poll keeps ordinary on-demand operation available. Add injected polling tests for no target, unrelated daemon checkout, tool-only repo and successful explicit startup binding. Runtime repair is tracked in https://github.com/trebizondoculpepper/github_triage/issues/291. Future roots acceptance separately covers worktrees, changed roots, ambiguity and identity isolation.

For read identity: explicit tool agent, then startup agent, then the selected repository's local identity entry when supported. Follow [identity.md](identity.md): root-level, Git-ignored `agent-inbox.toml`, one entry per logical agent, preserved `name` and separate `triage_role`. A verified harness signal can select an exact entry; ambiguous same-harness/server entries require explicit selection. Do not infer identity from the GitHub login or share one connection's selected project with another.

Project selection precedes local identity lookup. Without a verified local checkout, preserve explicit selection or unfocused reads with a notice; do not borrow a daemon's arbitrary working directory or a different project's identity. Client roots are optional capability-dependent context and must not block the explicit baseline. Ori-specific server prefixes are matched before embedded generic client names; distinct configured entries keep distinct names. Delivered (#271): with no tool `repo`, `--repo` or `--project`, a call returns the `repository-unresolved` guidance (naming `repo`, `--repo owner/name` and `--project /absolute/project/path`) without resolving the server's working directory; `--poll` likewise refuses to start without `--repo` or `--project`.

Delivered (#25): `src/readidentity.ts` composes the shared #70 reader and #38 resolver in this order: tool `agent`, startup `--agent`, then the persisted name of the entry chosen by `--entry`, `--harness`, verified client info (`ori-SERVER` → `ori.SERVER`) or environment detection. The project file is consulted only with `--project` and only when the selected repository matches that checkout. `selection` gains additive `entry`, `triageRole` and `identityDiagnostic` fields; `identitySource` is one of tool/startup/entry/harness/client/environment/unresolved. Every lookup failure stays local to identity and yields an unfocused read with that diagnostic. The adapter reads identity only: it does not create, rename, repair or regenerate the file. Missing file/entry/role yields actionable config/setup guidance without contacting another service. Use the shared maintained TOML parser/resolver; library selection is delegated under [the recommendation](../reports/toml-library-choice.md), not a pending owner decision. Preserve all credentials/private configuration and never return their contents. Setup/config writes belong to their separate command paths, not an MCP briefing side effect.

## Output, errors and lifecycle

Return compact readable `content` and validated `structuredContent`. The latter is an MCP-specific envelope:

```json
{
  "schemaVersion": 1,
  "kind": "briefing",
  "status": "complete",
  "selection": { "repository": "owner/repo", "agent": null, "identitySource": "unresolved" },
  "result": {},
  "error": null
}
```

`kind` is briefing/issue/dependencies; `result` contains the unchanged corresponding versioned CLI JSON. Preserve its schema, freshness, completeness, evidence and omissions. `status` is complete/incomplete/error; incomplete evidence must be visible in text and structured output and never interpreted as clean or eligible. The empty object above is an envelope illustration, not a valid collected briefing.

Argument validation uses SDK errors before collection. Operational failure returns `isError: true`, status error and a sanitized stable error code/message with valid inspection/retry guidance; partial useful evidence returns status incomplete with its warnings, not an invented success. No stack traces, raw subprocess stderr, tokens or full configuration dumps. Distinguish missing, inaccessible and transferred evidence using existing services. Avoid repeating all structured JSON in text; test older negotiated clients and document any SDK-required fallback representation.

Stdio stdout is protocol only. Logs, startup messages and update notices cannot corrupt it. A client disconnect/cancellation stops further collection where supported and cleans up child processes; do not report a cancelled fetch as complete. Preserve per-call context: concurrent requests must not overwrite a global current repo/agent. Do not reuse one client's roots/identity in another connection. There is no listener, polling loop, daemon, background startup task or idle-wake promise.

## Packaging and setup

Ship a second bundled executable **`github-triage-mcp`** at `dist/mcp.mjs` in the same scoped npm package, alongside the existing bin. Update the allowlist/installed-archive test intentionally for the second artifact. Global install remains recommended; hosts launch `github-triage-mcp --project /absolute/project/path`. The source entry point is `src/mcp.ts`; development uses the TypeScript migration’s approved runner or precompilation path, with type checking retained even if using native TypeScript execution. Installation must not register a host or modify live config automatically.

Document a generic stdio configuration with command/argument array, plus verified host-specific examples. The executable name is not a separate npm package: do not recommend `npx -y github-triage-mcp`. If documenting temporary npm execution, use the actual scoped package and version with npm exec, validated in the archive test. Every example is marked planned until installed-bin smoke passes.

## Acceptance and implementation handoff

After this contract merges, #25 can implement the read-only baseline separately from setup and wake-up. Use a real SDK client to initialize, list exactly three tools and call each through injected credential-free fixtures. Assert CLI/MCP result parity, output-schema validation, invalid input, incomplete/denied evidence, identity ambiguity/roots absence, Ori-entry separation, cross-project selection, concurrent calls, cancellation and stdout cleanliness. Negotiated older clients must either work via SDK compatibility or fail explicitly; do not claim universal host support.

Pack/install the exact archive into a temporary global prefix; launch its MCP bin and complete a stdio round trip on the selected current LTS and any additional supported recent version. Record at least one real host/client smoke with version and content/structured-content visibility; do not require paid model turns to test framing. Compare result bytes, actual host-visible tokens when measurable, API calls and latency for implementer intake and since-based catch-up. Structured content can still reach a model, so it is not automatically token-free.

No live claims, hooks, watchers, credential changes or npm publication are acceptance tests. Mutation/role features and automatic identity writes remain outside this ticket. Missing host evidence is a stated limitation, not silently inferred compatibility.

Briefing mode (#171): `triage_briefing` also accepts `mode: "actions" | "briefing"` (default `actions`, unchanged) and, for briefing mode only, `last`. Briefing mode returns envelope kind `repository-briefing` with the CLI `briefing --json` report; it exposes no checkpoint, cache, path or offline input and never advances a checkpoint. See [briefing-mode.md](briefing-mode.md#slice-4-implementation-notes-171).

## Role views (#260)

Blended role queues ([blended-action-queues.md](blended-action-queues.md)) require that CLI and MCP consume the same policy result, so `triage_briefing` in actions mode gains two additive, strict optional arguments: `role` (a registered role name: `implementer` or `designer`) and `order` (`impact`, `oldest` or `newest`, default `impact`). They mean exactly what CLI `--role` and `--order` mean. Both are rejected in `mode: "briefing"`. No `estimate`, `full`, checkpoint, cache or offline argument is added; ordinary role views already include assessment actions without `--estimate`.

For the same repository, agent, since, limit, role, order, collected facts, configuration and clock, the envelope `result` carries the same compact report fields as CLI `--json` with those flags: `actions`, `role` (including `role.next`), `rankedActions`, `estimation` and `impactEstimation` are equal, including order, reasons, counts and omissions. Without `role` the result is unchanged. Role is not inferred from the identity entry's `triage_role`; the selection reports `triageRole` so a client can pass it explicitly. The envelope stays `schemaVersion: 1`; only additive fields appear in `result`, and the advertised input schema gains the two optional properties.

`limit` applies to `rankedActions` after ranking, as in the CLI. Size follows the response contract in force: today's version-1 envelope until #266 ships, then [mcp-bounded-results.md](mcp-bounded-results.md), whose byte budget, rank-before-limit and explicit omission rules apply to role views as to any briefing. A role view never bypasses that cap.
