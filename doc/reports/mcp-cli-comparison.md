# MCP versus CLI: output size and wall time (#25)

Measured 2026-11-13 with `npx tsx scripts/mcp-benchmark.ts` (defaults: 40 synthetic issues, 25 timed runs per row after one warm-up) on Node v26.7.0, Apple M3 Max. Rerun the script to reproduce; `--json` gives machine-readable rows, `--issues N` and `--runs N` change the fixture size and sample count.

## Method

Both interfaces run in one process over the same injected, deterministic synthetic snapshot: no `gh`, no GitHub, no credentials, no network. The CLI is driven through `main` with an injected runtime and `--no-update-check`; the MCP server is the real `createServer` behind the official `@modelcontextprotocol/client` SDK client over the SDK's in-memory transport. The CLI and MCP reads therefore share collection, briefing and presentation code; what differs is the adapter and the serialized output.

For each scenario the script records the CLI text output, the CLI `--json` output as printed (indented with two spaces) and minified, and, from one `tools/call` result, the MCP `content` text, `structuredContent` serialized as compact JSON, and the whole result serialized (both together, which is roughly what a host receives). Character counts are JavaScript string lengths. Token counts are an approximation: characters divided by four, rounded up. That ratio is a common rule of thumb for English and JSON, not a measurement with any model's tokenizer. Wall time is the median of the timed runs; for MCP rows it is one `tools/call` round trip, shared by the three MCP output rows.

## Results

| Scenario                            | Output                            | Characters | ~Tokens (chars/4) | Median ms |
| ----------------------------------- | --------------------------------- | ---------: | ----------------: | --------: |
| briefing                            | CLI text                          |       7918 |              1980 |     27.51 |
| briefing                            | CLI --json (as printed, indented) |      39112 |              9778 |     27.26 |
| briefing                            | CLI --json (minified)             |      30713 |              7679 |     27.26 |
| briefing                            | MCP content text                  |       7921 |              1981 |     28.22 |
| briefing                            | MCP structuredContent             |      30408 |              7602 |     28.22 |
| briefing                            | MCP full result (both)            |      38493 |              9624 |     28.22 |
| implementer intake (issue 3, agent) | CLI text                          |      10161 |              2541 |     27.07 |
| implementer intake (issue 3, agent) | CLI --json (as printed, indented) |      41477 |             10370 |     27.00 |
| implementer intake (issue 3, agent) | CLI --json (minified)             |      32445 |              8112 |     27.00 |
| implementer intake (issue 3, agent) | MCP content text                  |       7842 |              1961 |     29.47 |
| implementer intake (issue 3, agent) | MCP structuredContent             |      32132 |              8033 |     29.47 |
| implementer intake (issue 3, agent) | MCP full result (both)            |      40139 |             10035 |     29.47 |
| since catch-up                      | CLI text                          |       7918 |              1980 |     28.42 |
| since catch-up                      | CLI --json (as printed, indented) |      39249 |              9813 |     29.03 |
| since catch-up                      | CLI --json (minified)             |      30801 |              7701 |     29.03 |
| since catch-up                      | MCP content text                  |       7921 |              1981 |     29.09 |
| since catch-up                      | MCP structuredContent             |      30496 |              7624 |     29.09 |
| since catch-up                      | MCP full result (both)            |      38581 |              9646 |     29.09 |

## Observations

- MCP `content` text is within a few characters of CLI text for the briefing. The texts are not identical: the MCP text starts with a 74-character identity notice (no agent was selected), and the CLI text contains other lines that the MCP text does not; the net difference is 3 characters. This report does not break that difference down further. For implementer intake the MCP text is about 23% shorter than the CLI text, because the MCP adapter leaves the full serialized issue detail in `structuredContent` and puts an omission notice in the text instead.
- `structuredContent` is within about 1% of the minified CLI `--json`; the envelope adds a few fields and omits the CLI's `checkpoint`. The CLI's printed JSON is about 27% larger than minified only because of indentation.
- A host that forwards both `content` and `structuredContent` to the model sends roughly the text plus the JSON, about the size of the indented CLI JSON. Structured content is not automatically token-free (doc/design/mcp.md); whether it reaches the model depends on the host.
- Wall time is the same within about 2 ms per call (roughly 27 to 29 ms) in-process. The time is dominated by the shared briefing work, not by the adapter.

## Limitations

- Synthetic data only: 40 open issues with uniform bodies and up to three comments, no pull requests, no dependencies, no warnings. Real repositories will produce different sizes and ratios.
- The since catch-up scenario as constructed does not narrow the output: its numbers match the full briefing apart from the `since` field. It measures the cost of the call path, not the savings of a real catch-up against changed evidence.
- Token counts are a chars/4 estimate, not host-visible or tokenizer-measured counts. Actual host-visible tokens were not measured: that needs a real host (see doc/mcp-host-smoke-test.md).
- Timings are in-process. They exclude process start-up, stdio framing, `gh` subprocesses and GitHub API latency, which dominate a real call. API-call counts are identical by construction (both use the same `collect`), so they were not measured separately.
- `triage_dependencies` was not measured.
- One machine, one run; timing differences of a few milliseconds are within noise.
