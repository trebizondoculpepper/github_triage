# Standalone project identity

## Scope and current behavior

Persistent agent names are distinct from GitHub accounts, harnesses and sessions. Use explicit `--agent NAME` / `--agent=NAME`; MCP tool selection overrides startup defaults for that call. Current unfocused reads remain useful when no identity is provided. Identity-dependent mutations require explicit supported identity selection. A name is workflow attribution, not authentication or proof of presence.

Owner decision: this project must remain independent of personal infrastructure and unrelated coordination services. Earlier proposals to share another application's configuration are withdrawn. No external identity file, service, client or upstream writer fix is a prerequisite for triage.

## Future local resolution

Follow the repository configuration boundary: agents use supported commands rather than edit storage directly. Persistent identity setup (#70), harness/server-entry mapping (#38) and local doctor (#64) need their own reviewed storage/validation contract before implementation. Do not invent new keys or silently add an identity registry to shared non-secret repository configuration. Separate local agent identity from versioned repository policy and from credentials.

Project selection precedes identity lookup. Explicit selection wins over verified detection; missing or ambiguous evidence never selects the first agent or borrows another project's identity. Client metadata identifies a harness, not a unique agent. Distinct configured server entries, including Ori entries, need distinct persistent names. A process/session identifier is not a persistent name. Default presentation role remains `triage_role`, independent of host metadata. Multiple designers coordinate through issue/PR discussion; no leader is elected automatically.

## Safety and delivery

Read-only resolution never writes, repairs or regenerates configuration. Missing identity does not disable unfocused inspection. Future writers preserve unrelated data, use validated keys and safe quoting, and detect concurrent edits. Doctor reports missing, malformed or ambiguous identity without repairing it. Return no credentials, raw private configuration or private paths in tool output.

The baseline MCP adapter can continue using explicit project/repository/agent selection. Automatic client roots, verified harness mappings and persistent setup remain separately tested follow-ups, not dependencies on another project. The [identity isolation note](../reports/identity-isolation.md) records the resulting boundary. This contract changes documentation only; it does not claim new lookup or setup behavior is implemented.
