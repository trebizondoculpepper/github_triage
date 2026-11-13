# Local identity and service independence

The owner's clarified boundary retains `agent-inbox.toml` as the Git-ignored, non-versioned identity store at the repository root. Reuse its format and existing agent names; add only the selected agent's `triage_role` (`designer` or `implementer`) while preserving unrelated data. Setup creates the file when absent. The file is not retired.

The project requires no separate communications service, check-in, network account or personal configuration. Reusing a filename and format does not require that other software be installed. The previous interpretation that a separate triage-owned identity file was needed is withdrawn.

Follow [the persistent identity contract](../design/identity.md): shared resolution and config-mediated safe writes, verified harness/entry selection, local Git exclusion and read-only Doctor checks. A name persists across sessions but is not authentication or proof of presence. No live identity file or credentials changed in this documentation correction.
