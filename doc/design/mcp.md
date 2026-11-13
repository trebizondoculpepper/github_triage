# Baseline MCP interface

Contract for #25, informed by #19 and identity investigation #69. This is a documentation-first read-only adapter; no MCP runtime is shipped by this document. Polling #32, wake-up adapters #26–#29 and shared backend #42 are independent follow-ups.

## SDK and architecture

Use the official **`@modelcontextprotocol/server` v2** and Zod v4 with TypeScript source, emitted ESM and Node 20+ (owner language decision #91). On 2026-11-13, `npm view @modelcontextprotocol/server version engines dependencies --json` reports 2.4.0, Node >=20, core 2.4.0 and Zod ^4.2.0. The [official tool documentation](https://ts.sdk.modelcontextprotocol.io/v2/servers/tools.html) provides registration and validated input/output schemas; [stdio documentation](https://ts.sdk.modelcontextprotocol.io/v2/serving/stdio.html) provides `serveStdio(factory)` and protocol negotiation. Pin the reviewed dependency selection through the lockfile; recheck API/engines at implementation rather than invent framing or adopt a framework.

Create a transport-neutral read service around existing collection, dependency and presentation functions, with injected GitHub/clock/project/filesystem boundaries. CLI and MCP call it directly; do not invoke the CLI in a subprocess or parse terminal text. Reuse authenticated `gh` via the existing argument-array runner. No new credential store or token arguments. Keep mutation imports/routes separate and unavailable through this tool registry.

## Three discoverable tools

All inputs are strict objects: unknown properties fail validation. Shared optional `repo` follows the existing owner/name validator. Positive issue numbers are safe integers. `agent` is a persistent name used for read presentation, not authentication. Validate dates with the existing ISO-with-time semantics. Defaults and bounds below are public MCP argument constraints, not silent truncation of source evidence.

| Tool                  | Inputs                                                                                                      | Result                                                                                                   |
| --------------------- | ----------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `triage_briefing`     | `repo?`, `agent?`, `since?`, `limit?` integer 1–100 default 5, `maxChars?` integer 1000–40000 default 10000 | Existing compact briefing JSON plus compact evidence-linked text                                         |
| `triage_issue`        | `number` required, `repo?`, `agent?`, `maxChars?` same bounds/default                                       | Full existing issue intake/history/dependency evidence as JSON; concise text with detail/omission notice |
| `triage_dependencies` | `number` required, `repo?`, `tree?` boolean default false                                                   | Existing native dependency JSON and concise dependency text                                              |

Use short descriptions explaining when to call each tool. All advertise `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true`, `openWorldHint: true`; annotations are hints, not access controls. Remote evidence may change between identical calls.

Do not add mutation tools, generic shell/GitHub request tools, arbitrary URLs, file paths, cache/checkpoint writes, offline loading, migrations, team view or role flags to this baseline. Newly shipped CLI capabilities are not automatically new MCP tools. `since` supports owner catch-up without persisting hidden per-agent checkpoints. Dedicated role views follow #1; the baseline must not claim to compute an unimplemented owner/designer policy.

## Selection and identity

Startup accepts explicit `--project PATH`, `--repo owner/name`, `--agent NAME`, `--harness KEY` and `--entry KEY`; these are adapter options to be implemented, not existing CLI flags. `--project` supplies a configured local project default; it is not a per-tool arbitrary filesystem-read option. Keep current CLI argument behavior unchanged.

For each call: explicit tool repo wins over server repo default. Without either, use one applicable client root, then the configured project default and the normal local repository resolver. Normalize roots as local file URLs and verify their project relationship. Multiple applicable projects, non-local roots and an unresolvable target produce selection guidance, not an arbitrary first project or Ori daemon cwd. Only request roots if advertised; initialization must not require unsupported client capabilities.

For read identity: explicit tool agent, then startup agent, then an explicitly selected or verified detected harness/entry in that selected project's `agent-inbox.toml`. Tool-level explicit selection changes only that call. Project selection precedes local identity lookup; never borrow the starting project's identity when inspecting another repository. No matched local project means unfocused reads unless identity was explicitly supplied. Client metadata describes a harness; it does not authenticate a person or establish same-harness uniqueness.

Follow [identity.md](identity.md): `triage_role` is distinct from mailbox role. Unknown or ambiguous identity yields useful unfocused reads with a notice, not an invented name. Verified exact mappings and explicit overrides take precedence over substring guesses. Ori per-server names must remain distinct; missing entry identity must not fall back to another Ori entry. Read TOML with a maintained parser compatible with Node 20; do not hand-parse it. Select/document that parser in the implementation review.

#69 demonstrated that Agent Inbox's writer drops unknown fields and does not establish Ori prefix mapping. This adapter **never writes, joins, repairs or regenerates identity files**. Automatic lookup is enabled only for explicitly selected/verified unambiguous existing entries; unsupported mappings stay unresolved. This permits baseline reads without claiming setup #70 or upstream writer compatibility is solved. Do not return TOML contents, tokens or private paths in tool results.

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

Ship a second bundled executable **`github-triage-mcp`** at `dist/mcp.mjs` in the same scoped npm package, alongside the existing bin. Update the allowlist/installed-archive test intentionally for the second artifact. Global install remains recommended; hosts launch `github-triage-mcp --project /absolute/project/path`. The source entry point is `src/mcp.ts`; development uses the TypeScript migration’s approved runner or precompilation path, not direct Node 20 execution of TypeScript. Installation must not register a host or modify live config automatically.

Document a generic stdio configuration with command/argument array, plus verified host-specific examples. The executable name is not a separate npm package: do not recommend `npx -y github-triage-mcp`. If documenting temporary npm execution, use the actual scoped package and version with npm exec, validated in the archive test. Every example is marked planned until installed-bin smoke passes.

## Acceptance and implementation handoff

After this contract merges, #25 can implement the read-only baseline separately from setup and wake-up. Use a real SDK client to initialize, list exactly three tools and call each through injected credential-free fixtures. Assert CLI/MCP result parity, output-schema validation, invalid input, incomplete/denied evidence, identity ambiguity/roots absence, Ori-entry separation, cross-project selection, concurrent calls, cancellation and stdout cleanliness. Negotiated older clients must either work via SDK compatibility or fail explicitly; do not claim universal host support.

Pack/install the exact archive into a temporary global prefix; launch its MCP bin and complete a stdio round trip on Node 20 and a current supported Node. Record at least one real host/client smoke with version and content/structured-content visibility; do not require paid model turns to test framing. Compare result bytes, actual host-visible tokens when measurable, API calls and latency for implementer intake and since-based catch-up. Structured content can still reach a model, so it is not automatically token-free.

No live claims, hooks, watchers, credential changes or npm publication are acceptance tests. Mutation/role features and automatic identity writes remain outside this ticket. Missing host evidence is a stated limitation, not silently inferred compatibility.
