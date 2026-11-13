# Agent Inbox identity-file compatibility (#69)

Investigation report. No Agent Inbox code and no live identity configuration was changed. It verifies, by running Agent Inbox's own writers, whether triage can safely share the project identity file (`agent-inbox.toml`) as the contract in [doc/design/identity.md](../design/identity.md) requires.

**Result: shared writes are not safe yet.** Any Agent Inbox write to a project file erases every key it does not know, including triage's `triage_role` and Agent Inbox's own interrupt policy. Engine keys are not quoted, and Ori server entries are not recognised. Triage must keep shared identity writes disabled until the upstream changes listed below land and pass the fixtures here. Explicit `--agent NAME` triage and read-only lookup remain usable.

## Evidence

Agent Inbox `main` at `8c74488f8db2590902c81bb72c5ab68ffb830820` (2026-11-12 21:35 UTC), still its latest commit when inspected on 2026-11-13. Source was exported with `git archive` into a scratch directory, so the sibling checkout was untouched, and run with Python 3.14 in a disposable `uv` environment with a temporary `HOME`.

### What the code does

- `src/agent_inbox/client.py`, `_render_project` is the single writer of the project file. It rebuilds the file from scratch: `hub`, then for each `[agents.<key>]` only `name`, `role`, `token` and `wake`. Its own comment calls the renderer "the whitelist". Every caller (`write_config` for join/configure, `write_project` for settings, `unset_project`) goes through it, and each renders **all** entries, not only the caller's.
- `[agents.{key}]` is emitted without quoting the key.
- `src/agent_inbox/mcp_client.py`, `engine_for_client`: an exact table (`{"ori": "ori"}`) followed by substring rules for other engines.

### What running it does

Input fixture:

```toml
hub = "http://hub.example:8080"

[interrupt]
wake_from = ["ludmila_coe"]
max_per_minute = 4

[agents.claude]
name = "kavya_sabbagh"
role = "agent"
token = "FIXTURE-TOKEN-NOT-REAL"
triage_role = "implementer"
unknown_key = "keep-me"

[agents.claude.interrupt]
wake_from = []

[agents."ori-alpha"]
name = "polikarp_alemdar"
role = "agent"
triage_role = "designer"

[agents."ori-beta"]
name = "vijay_larionova"
role = "agent"
triage_role = "implementer"
```

| Step                                                      | Result                                                                                                                                                                                                                                |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `write_config(..., engine="codex")`: another engine joins | Top level keeps only `hub`; **`[interrupt]` lost**. `claude` keeps `name`, `role`, `token`; **`triage_role`, `unknown_key` and `[agents.claude.interrupt]` lost**. `ori-alpha` and `ori-beta` **lose `triage_role`**. Tokens survive. |
| `write_project({"wake": "on"}, engine="claude")`          | Adds `wake`; nothing lost earlier comes back.                                                                                                                                                                                         |
| `write_config(..., engine="ori.gamma")`                   | Written as `[agents.ori.gamma]`, which TOML parses as a nested table: the agents map gains a phantom `ori` entry.                                                                                                                     |
| `engine_for_client(name)`                                 | `ori` → `ori`, `Ori` → `ori`, **`ori-alpha` → `None`**, **`ori-codex` → `codex`**, `codex` → `codex`, `claude-code` → `claude`, `prioritiser` → `None`                                                                                |

So:

1. **Unknown keys are erased by any engine's write.** This breaks triage's `triage_role` (owner-approved for this file) and also Agent Inbox's own documented `[interrupt]` policy and per-engine `[agents.<engine>.interrupt]` overrides (`doc/interrupting-an-agent.md`): a `join` by one engine silently removes everyone's interrupt policy.
2. **Keys needing quotes corrupt the structure.** Today's engine names are bare-key safe, but per-server Ori keys or any name with `.` would not be.
3. **Ori server entries cannot be told apart, and embedded names win.** A per-server client name such as `ori-alpha` is unrecognised, and `ori-codex` is identified as Codex, the case the contract says must not happen. Agent Inbox's 1.8.2 notes (exact `ori` match, #91) are consistent with this; per-server identity is not implemented.
4. **Restart stability holds for existing entries.** `write_config` refuses to change an existing engine's name without `force`, and keeps an existing token. Names are therefore not regenerated on restart, provided an entry is found for the engine.

## Compatibility fixtures (acceptance for the upstream change)

Run each through Agent Inbox's writers (`write_config` join of a new engine, `write_config` with `force`, `write_project`, `unset_project`) and through triage's planned setup writer (#70). After each, parse the file and assert:

1. **Preservation:** every key and table not being changed survives, at every level: top-level tables (`[interrupt]`), entry keys (`triage_role`, unknown keys), entry subtables (`[agents.claude.interrupt]`). Values are unchanged.
2. **Credentials:** `token` values are preserved byte for byte, never printed, and the file stays readable only by the user, as today.
3. **Distinct Ori entries:** `ori-alpha` and `ori-beta` remain separate entries with their own `name` and `triage_role`; writing one never changes the other.
4. **Quoted keys:** an entry key containing `.`, `:` or spaces round-trips as one entry (`[agents."ori.gamma"]`), and no phantom parent entry appears.
5. **No regeneration:** re-running join or setup for an engine that already has an entry keeps its name and token. Restart does not create a new name.
6. **Explicit override:** an explicit `--agent NAME` (triage) or `--engine` (Agent Inbox) selection still wins over detection.
7. **Detection:** `engine_for_client` maps a verified Ori per-server client name (the exact form Ori sends, to be confirmed from Ori) to that server's entry key, never to an engine named inside it; `ori-codex` must not resolve to `codex`.

## Required upstream changes

Filed upstream as [trebizondoculpepper/agent-inbox#92](https://github.com/trebizondoculpepper/agent-inbox/issues/92).

1. **Preserve what the writer does not own.** Render from the parsed document and change only the keys being set, instead of reconstructing a whitelist. A TOML library that keeps unknown keys and tables (and ideally comments), or a minimal edit, would do. This also fixes Agent Inbox's own interrupt-policy loss.
2. **Quote entry keys** whenever they are not bare-key safe.
3. **Per-server Ori identity:** define the client-name form Ori sends per configured server, map it to its own entry key, and check exact and prefix forms before substring rules.
4. Add the fixtures above to Agent Inbox's tests.

## Consequences for this project

- Keep shared identity writes (setup #70, `doctor --fix`) **disabled** until a released Agent Inbox passes fixtures 1 to 7. `doctor` (#64) should report the limitation, not repair it.
- Reading `agent-inbox.toml` for lookup is safe today; tolerate missing `triage_role` and treat an unknown identity as unresolved, as the contract requires.
- Explicit `--agent NAME` remains the supported way to focus triage.
- MCP (#25) and Ori identity (#38) must not rely on per-server Ori detection until item 3 ships; they need explicit selection meanwhile.

## Reproducing

From a scratch directory (never inside the Agent Inbox checkout):

```sh
git -C /path/to/agent-inbox archive 8c74488 src | tar -x -C ai-src
mkdir -p proj && (cd proj && git init -q) && cp fixture.toml proj/agent-inbox.toml
HOME=$PWD/home uv run --isolated --no-project --python 3.14 \
  --with httpx --with anyio --with mcp --with fastmcp \
  python -I roundtrip.py ai-src proj
```

`roundtrip.py` imports `agent_inbox.client` and `agent_inbox.mcp_client` from `ai-src/src`, prints the key structure before and after `write_config` (new engine `codex`), `write_project` (`wake` for `claude`) and `write_config` (engine `ori.gamma`, `force=True`), and calls `engine_for_client` for the names in the table above.
