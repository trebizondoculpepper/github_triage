# MCP repository-selection clarification

Resolved #256 questions against the existing mcp.md contract and the observed Ori daemon-directory bug #271: a valid server cwd still does not identify the caller project. Explicit selection remains the baseline; one verified client root can be used only after optional roots work is reviewed/delivered. No host special cases, new resolver or runtime changes. Cleared stale #190 documentation markers after merged #277 and closed native prerequisites.

Review follow-up: independently verified the unguarded polling startup path in src/mcp.ts. Added polling-specific binding/refusal requirements and filed a focused runtime defect; documentation changes do not claim the watcher is fixed.
