# Design closeout

Consolidated the owner’s discussion into focused contracts under doc/design, separate from runtime implementation. Clarified precedence over inherited proposals and split delivery/deferral boundaries. Added triage-first investigation guidance and global-install recommendation. Inspected Agent Inbox source at 8c74488: writer drops triage_role and Ori client-name handling does not match the proposed prefix assumptions. Identity writes remain blocked pending compatibility work; no live configuration changed. Shared dirty workspace and source files are untouched.

Validation is recorded in the documentation PR. Product decisions are distinguished from delegated implementation details and engineering blockers. Implementation must follow the merged contracts, not assume this draft is shipped behavior.
