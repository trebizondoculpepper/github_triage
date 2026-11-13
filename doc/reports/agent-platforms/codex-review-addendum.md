# Independent Codex platform review addendum (#224)

Reviewed on 2026-11-13 against `origin/main` commit `e071076f83c9a3941945e9eaa46dce0e85c298ba`. This supplements `doc/reports/agent-platforms/codex.md`, merged through PR #233, and its predecessor `doc/reports/codex-idle-wakeup.md`. Line references below refer to that commit. The original report remains intact.

The main recommendation is sound: retain ordinary MCP tools, and evaluate the native `codex queue` route separately for an explicitly bound existing session. The SDK and ACP adapter are suitable for controller-driven work; neither establishes attachment to the user's running CLI, Desktop or IDE agent. Three corrections improve the precision of the report without changing that recommendation.

## Findings and corrections

### Medium: a started turn does not prove delivery of a particular queued batch

Report lines 52 and 86 distinguish a started turn from a queued message, but line 86 proposes using `turn/started` to confirm delivery; the final proposed follow-up similarly suggests turning `queued` into `observed` through that notification. A turn can start for unrelated input on the same thread. Conversely, input steered into an active turn does not emit a new `turn/started` event. The protocol describes turn lifecycle, not acknowledgment of this project's opaque batch ID. See the official [turn steering documentation](https://learn.chatgpt.com/docs/app-server#turnsteer) and [event documentation](https://learn.chatgpt.com/docs/app-server#events).

Correction: treat `turn/started` as evidence that a particular thread began a turn. Correlate the exact batch with host input/history evidence before calling the notice observed, and require the agent's ordinary triage inspection before advancing its acknowledgment checkpoint. Define which evidence each adapter result requires. The original lines 60 and 62 already preserve the stronger inspection and authorization boundaries.

The observer proposal also needs a subscription step: `thread/loaded/list` enumerates loaded IDs; it does not itself subscribe the caller to those threads. The official [thread read documentation](https://learn.chatgpt.com/docs/app-server#threadread) distinguishes reading history from resuming and subscribing. A later observer design must establish how it subscribes without changing the original host's lifecycle or approval handling. This review did not establish that safe shared-client behavior.

### Low: SDK thread handles are lazy; resume is not an immediate process or history load

Lines 10, 16 and 52 imply that calling `resumeThread(id)` itself loads history into a new SDK process. Current official source shows that `startThread()` and `resumeThread(id)` construct `Thread` objects. The run generator invokes the exec boundary, which launches `codex exec` and supplies `resume` with the ID when present. `runStreamed()` also returns a lazy event iterator: the work proceeds when that iterator is consumed. See [codex.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/codex.ts), [thread.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/thread.ts) and [exec.ts](https://github.com/openai/codex/blob/main/sdk/typescript/src/exec.ts).

Correction: `resumeThread(id)` creates a handle for an existing persisted thread. Executing a prompt through that handle starts a separate CLI invocation that resumes the persisted conversation; it does not attach to the existing interactive process. Constructing a handle alone neither starts a model turn nor establishes delivery. Executing prompts requires a separately authorized model budget; a successful paid completion is not guaranteed merely by calling an SDK method. This preserves the report's central session-ownership distinction.

### Low: the history/resume capability row has an unescaped table delimiter

At line 42, the pipe inside the inline command `codex resume [ID | --last]` splits the Markdown table cell. The resulting row shifts IDE/Desktop, headless, provider and source entries under the wrong headings and has an extra cell.

Correction: express the CLI cell as `S (codex resume ID, codex resume --last, codex fork)`, leave IDE/Desktop as `C`, and keep the SDK/exec/app-server entries in the headless cell. No capability change is implied.

## Confirmed boundaries

The installed CLI's `codex queue --help` confirms that `--resume` attempts to resume through the local daemon or selected remote server and that a failed resume can still leave the command successful. The current official [developer commands reference](https://learn.chatgpt.com/docs/developer-commands#codex-queue) agrees. Exit status must therefore remain separate from turn start, receipt and inspection.

The official [SDK README](https://github.com/openai/codex/blob/main/sdk/typescript/README.md) supports CLI spawning, JSONL events, persisted-history resume and optional environment replacement. The official [codex-acp README](https://github.com/agentclientprotocol/codex-acp) states that the adapter starts an App Server; its [steering documentation](https://github.com/agentclientprotocol/codex-acp/blob/main/docs/steering.md) distinguishes injection, new-turn start and the opt-in prompt-required idle fallback. These sources support the report's decision against using those packages as an assumed bridge into another client's running agent.

An app-server integration that drives work must account for authentication, permissions and server-initiated approval requests. The report's proposed observer must be evaluated separately: reading protocol documentation does not prove that joining another host's live thread preserves that host's approval ownership. Neither MCP tool registration nor a loaded thread listing grants that authority.

## Review environment and limits

This review ran as a delegated Codex subagent, with a shared macOS filesystem reporting Darwin 27.2.0 arm64, Node v26.7.0 and installed `codex-cli 0.167.2`. The actual model identifier and enclosing Codex client application/version were not exposed to the reviewer. The CLI version describes the installed executable, not proof that the enclosing host uses that executable. The original report's author identity does not establish their harness or model; this addendum makes no independent claim about them.

Checks were source inspection, current official documentation fetched through Firecrawl, local `codex --version`, `codex --help` and `codex queue --help`, and read-only project triage intake. Git content was read from `origin/main`; the older dirty shared checkout was preserved. The SDK source checks used upstream `main`, not an installed or pinned SDK runtime; the distinction should be rechecked against the selected package release before implementation. Registry versions and release cadence were not independently re-audited.

No SDK/ACP model run, new Codex session, queue submission, daemon launch, wake injection, Desktop/IDE experiment, host configuration change or GitHub write was performed. Existing-session queue behavior, busy-versus-idle behavior, shared-client subscriptions and approvals, reconnect behavior, cross-session isolation, batch correlation and agent inspection acknowledgment remain empirical verification gaps. No successful wake or end-to-end delivery is claimed.
