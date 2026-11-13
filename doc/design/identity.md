# Persistent repository-local agent identity

## Owner decision and why

An agent needs a stable name when it returns to the same repository. Keep the existing `agent-inbox.toml` format at the Git working-tree root. Reuse that file and names if present; setup creates it if absent. It is local, non-versioned and Git-ignored. Sharing the filename/format requires no external service, installed application, network check-in or personal infrastructure. The earlier interpretation that the local identity file itself was retired is superseded.

One table represents each logical agent entry:

```toml
[agents.codex]
name = "stable-agent-name"
triage_role = "implementer"

[agents."ori.review"]
name = "another-stable-name"
triage_role = "designer"
```

`triage_role` accepts `implementer` or `designer` for now. It is separate from an existing `role` key: preserve that key and all other existing values. The name is workflow attribution, not authentication or live presence. Do not derive it anew from a process/session ID, GitHub login or current task.

## Find the correct repository and entry

Use the Git working-tree root, resolved through Git rather than requiring `.git` to be a directory. Run from nested directories safely; worktrees with a `.git` file must work. Never walk above the selected repository boundary or read a parent/sibling project's identity. Explicit target selection must agree with the local checkout before a write. A remote `--repo` alone cannot select an unrelated local identity file.

The inspected reference implementation walks upward until an existing `.git` boundary and supports nearer files. Triage follows the owner's root-level location: use `<working-tree-root>/agent-inbox.toml`, not a random nested file or the shared Git metadata directory. No home-directory/global identity fallback is added. Bare/outside-Git contexts produce actionable project-selection guidance instead of creating identity in an arbitrary directory.

Resolve the logical agent entry through one shared resolver: explicit `--entry KEY`, then an explicit supported `--harness KEY`, then verified current-harness detection. A detected harness selects an exact supported entry key; several logical entries using that harness require explicit selection. Never borrow the first/only unrelated entry. Existing `--agent NAME` remains an explicit per-call identity override; it is not a storage-section key and does not rename a persisted entry.

Maintain a tested detector registry, not scattered guesses. The inspected source recognizes Claude signals such as `CLAUDECODE`/`CLAUDE_CODE_ENTRYPOINT`, and Codex signals including `CODEX_THREAD_ID`, `CODEX_SANDBOX`, `CODEX_MANAGED_BY_NPM` and `CODEX_CI`. Host signals can be inherited: prioritize verified more-specific child signals, and report conflicting/ambiguous evidence instead of selecting another agent. A configured `CODEX_HOME` alone may describe installation rather than prove a live Codex session; test actual semantics before trusting a weak marker. Do not print environment values.

For MCP, explicit project/repository/agent/entry selection works without client roots. Project selection precedes identity lookup; verified client metadata can identify a harness but not a unique agent. Ori-prefixed per-server names must be matched before embedded generic harness names, with separate persistent identities for distinct configured server entries. Ori shell detection must be verified against actual supported signals; absence does not justify guessing from daemon cwd or an inherited parent marker. Missing/ambiguous identity permits unfocused reads with a notice; writes to per-agent settings require a resolved entry or explicit selection.

## Configuration command boundary

Reuse the merged `config get`, `set`, `list` and `help` layer; agents do not edit files directly. Add registered per-agent settings `identity.name` and `identity.triage_role`, routed to the selected table's `name` and `triage_role` keys. Example planned commands:

```sh
github-triage config get identity.name
github-triage config set identity.triage_role implementer
github-triage config set identity.triage_role designer --entry codex
github-triage config help identity.triage_role
```

Without explicit selection these use the shared harness/root/entry resolver. Report which repository, entry and non-secret source decided the result. `list` exposes only registered settings for the selected agent and shared policy; never dump unrelated file contents, credentials or another agent's private data. Unknown identity does not break unrelated repository-config operations. CLI role overrides affect one view; `config set identity.triage_role ...` persists the default role.

Keep repository policy and local identity as different stores, both repository-scoped. The existing versioned repository settings service remains usable; its separate TOML conversion must not block identity. Planned `.github/triage.toml` holds shared policy, not identity names or secrets. The already implemented JSON store remains the runtime fact until that conversion ships. There is no global/machine scope expansion in this work.

## Setup and safe writes

Planned `setup identity` uses the same resolver/configuration service. For a selected new entry, choose a random human-like name once, check for local name collisions and persist it with the requested/prompted triage role. Noninteractive setup needs an explicit valid role. A config write of identity.triage_role may use that same initializer for an absent selected file/entry: generate the name once and persist it with the requested role, without a second manual file-edit step. Never initialize until repository and logical entry are resolved. Read-only config operations never create a file. Repeated setup preserves the existing name. If a record exists, adding or changing `triage_role` preserves its name and existing `role`; do not normalize another agent's settings or silently rename anyone. An explicit name change is a separate config operation and never automatically rewrites GitHub claims/attention.

Use a maintained TOML parser/serializer. Recommended initial choice is `smol-toml`, with selection/revalidation and preservation fixtures documented in the [library note](../reports/toml-library-choice.md); a suitable equivalent is an engineering choice, not a new owner blocker. No hand-parsed TOML, whitelist reconstruction or assumption that unknown keys can be discarded. Do not add mandatory top-level version/schema keys to the shared identity format merely to store these two values.

Read and validate the whole document, preserve unknown keys/tables and typed values, quote entry keys safely and update only the selected registered setting. Use atomic writes and intervening-edit detection; malformed or concurrently modified files must not be overwritten. Preserve comments/formatting where practical, and explicitly document/test serializer normalization rather than claim byte preservation. Never return credentials or raw private configuration. Another application overwriting an added key is a missing-setting diagnostic, not permission to regenerate the name or contact a service.

Establish Git exclusion before creating a local identity file. Reuse existing ignore coverage; if needed, use the repository-local Git exclude path resolved by Git, without changing global ignore settings. The same-directory temporary copy used for the atomic rename (`agent-inbox.toml.<token>.tmp`) is excluded too (`/agent-inbox.toml.*.tmp`), even when the identity file is already ignored, so an interrupted write never leaves a stageable copy. Exclude rules are appended to the exclude file, never written by read-and-replace, so concurrent additions survive. A document whose rewrite would change a value (for example a timestamp with sub-millisecond precision, which the TOML serializer rounds to milliseconds) is refused unchanged. Already-tracked identity is a distinct diagnostic: do not automatically untrack, commit, delete or publish it. No live setup/configuration is changed by this document.

## Doctor, MCP and delivery

Doctor keeps local-file presence, parse validity, entry selection, name, role and ignored-versus-tracked checks. It reads through the same resolver and reports missing/ambiguous/invalid values with exact delivered config/setup recovery syntax. It never creates or repairs identity during a check. Reject invalid roles instead of interpreting the generic `role` field as `triage_role`.

#70 owns shared TOML identity resolution and config/setup writes; #38 owns verified harness/server-entry detection; #64 completes Doctor on those shared boundaries; #25 integrates read-only identity lookup with MCP while preserving explicit selection. Add native implementation dependencies without parent/child cycles. These contracts must merge before runtime changes. Future client-root support is separately tested and does not force a new identity store or external integration.
