# Identity isolation and configuration ownership

The owner withdrew earlier exploratory proposals to share identity configuration with a separate application. That investigation is no longer a prerequisite or implementation recommendation for this standalone project.

The relevant engineering lessons are retained: configuration writers must preserve unrelated keys, quote identifiers correctly, distinguish separate server entries and avoid claiming that harness metadata uniquely identifies an agent. Explicit agent selection remains supported; future automatic resolution and persistent local setup need their own reviewed contract and fixtures.

No credentials, private integration instructions, external checkout paths or service-specific identity schema belong in this repository. See [the standalone identity contract](../design/identity.md). Historical issue references do not reactivate the withdrawn integration. This note does not claim a new identity implementation or completed setup feature.
