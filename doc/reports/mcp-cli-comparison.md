# MCP versus CLI: output size and wall time (#25)

Measured 2026-11-13 with `npx tsx scripts/mcp-benchmark.ts` (defaults: 40 synthetic issues, 25 timed runs per row after one warm-up) on Node v26.7.0, Apple M3 Max. Rerun the script to reproduce; `--json` gives machine-readable rows, `--issues N` and `--runs N` change the fixture size and sample count.

## Method

Both interfaces run in one process over the same injected, deterministic synthetic snapshot: no `gh`, no GitHub, no credentials, no network. Every local boundary is injected as well: the workflow-guide and estimation settings read an empty in-memory filesystem and a fake git that reports a synthetic checkout (`/synthetic/checkout`) whose only remote is the synthetic repository, and the estimation field API throws if called. No configuration file exists, so both interfaces see the same default settings and the same `complexity-field-unmapped` finding, with no diagnostic naming a local directory. The script forbids subprocesses for the whole run (every `child_process` entry point throws) and fails if any measured output contains the real working directory or home directory, so results do not depend on the machine or checkout the script runs from. The CLI is driven through `main` with an injected runtime and `--no-update-check`; the MCP server is the real `createServer` behind the official `@modelcontextprotocol/client` SDK client over the SDK's in-memory transport. The CLI and MCP reads therefore share collection, briefing and presentation code; what differs is the adapter and the serialized output.

For each scenario the script records the CLI text output, the CLI `--json` output as printed (indented with two spaces) and minified, and, from one `tools/call` result, the MCP `content` text, `structuredContent` serialized as compact JSON, and the whole result serialized (both together, which is roughly what a host receives). Character counts are JavaScript string lengths. Token counts are an approximation: characters divided by four, rounded up. That ratio is a common rule of thumb for English and JSON, not a measurement with any model's tokenizer. Wall time is the median of the timed runs; for MCP rows it is one `tools/call` round trip, shared by the three MCP output rows.

## Results

| Scenario                            | Output                            | Characters | ~Tokens (chars/4) | Median ms |
| ----------------------------------- | --------------------------------- | ---------: | ----------------: | --------: |
| briefing                            | CLI text                          |       7630 |              1908 |      1.86 |
| briefing                            | CLI --json (as printed, indented) |      36945 |              9237 |      1.79 |
| briefing                            | CLI --json (minified)             |      28547 |              7137 |      1.79 |
| briefing                            | MCP content text                  |       7703 |              1926 |      2.27 |
| briefing                            | MCP structuredContent             |      28697 |              7175 |      2.27 |
| briefing                            | MCP full result (both)            |      36563 |              9141 |      2.27 |
| implementer intake (issue 3, agent) | CLI text                          |       9873 |              2469 |      1.73 |
| implementer intake (issue 3, agent) | CLI --json (as printed, indented) |      39310 |              9828 |      1.73 |
| implementer intake (issue 3, agent) | CLI --json (minified)             |      30279 |              7570 |      1.73 |
| implementer intake (issue 3, agent) | MCP content text                  |       7624 |              1906 |      2.02 |
| implementer intake (issue 3, agent) | MCP structuredContent             |      30421 |              7606 |      2.02 |
| implementer intake (issue 3, agent) | MCP full result (both)            |      38209 |              9553 |      2.02 |
| since catch-up                      | CLI text                          |       7630 |              1908 |      1.67 |
| since catch-up                      | CLI --json (as printed, indented) |      37082 |              9271 |      1.73 |
| since catch-up                      | CLI --json (minified)             |      28635 |              7159 |      1.73 |
| since catch-up                      | MCP content text                  |       7703 |              1926 |      1.90 |
| since catch-up                      | MCP structuredContent             |      28785 |              7197 |      1.90 |
| since catch-up                      | MCP full result (both)            |      36651 |              9163 |      1.90 |

## Observations

- MCP `content` text is 73 characters longer than CLI text for the briefing: the MCP text starts with a 74-character identity notice (no agent was selected). This report does not break the remaining one-character difference down further. For implementer intake the MCP text is about 23% shorter than the CLI text, because the MCP adapter leaves the full serialized issue detail in `structuredContent` and puts an omission notice in the text instead.
- `structuredContent` is within about 1% of the minified CLI `--json` (150 characters larger for the briefing); the envelope adds a few fields and omits the CLI's `checkpoint`. The CLI's printed JSON is about 29% larger than minified only because of indentation.
- A host that forwards both `content` and `structuredContent` to the model sends roughly the text plus the JSON, about the size of the indented CLI JSON. Structured content is not automatically token-free (doc/design/mcp.md); whether it reaches the model depends on the host.
- Wall time is about 2 ms per call in-process for both, with MCP roughly 0.2 to 0.4 ms slower (the SDK round trip). An earlier version of this benchmark measured about 27 to 29 ms per call; that time was two real `git` subprocesses per call (checkout and remote resolution for the guide and estimation settings), which the injected boundaries now remove.

## Limitations

- Synthetic data only: 40 open issues with uniform bodies and up to three comments, no pull requests, no dependencies, no warnings. Real repositories will produce different sizes and ratios.
- The since catch-up scenario as constructed does not narrow the output: its numbers match the full briefing apart from the `since` field. It measures the cost of the call path, not the savings of a real catch-up against changed evidence.
- Token counts are a chars/4 estimate, not host-visible or tokenizer-measured counts. Actual host-visible tokens were not measured: that needs a real host (see doc/mcp-host-smoke-test.md).
- Timings are in-process. They exclude process start-up, stdio framing, the local `git` lookups a real run makes for project settings, `gh` subprocesses and GitHub API latency, which dominate a real call. API-call counts are identical by construction (both use the same `collect`), so they were not measured separately.
- `triage_dependencies` was not measured.
- One machine, one run; timing differences of a few milliseconds are within noise.
