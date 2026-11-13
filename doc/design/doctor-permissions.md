# Doctor: configuration-driven GitHub permission checks

## Why

A working login does not prove that the token can perform the operations enabled for this repository. Conversely, requiring field-creation privileges when an existing field is usable adds unnecessary access and friction. Doctor must diagnose the actual configuration and give the next supported recovery command, without changing GitHub, authentication or local settings.

## Decision sequence

1. Resolve and validate the intended checkout and effective repository configuration through the shared service. Check Node, GitHub CLI availability and authentication independently so one failure does not hide other findings.
2. If `complexity.enabled` is false, skip complexity-field and complexity-specific permission checks. Ordinary repository access still matters; report skipped checks explicitly.
3. If enabled, determine whether the mapped native field is readable, compatible and usable. A missing mapping is a configuration problem, not proof that no suitable field exists. Discover compatible fields when needed; offer supported selection/setup guidance.
4. If a compatible field exists, check the access required to read it and, for estimate recording, update values on repository issues. Do not require field-creation or owner-wide administration permissions. An inaccessible field is unknown/unavailable, not absent.
5. Only when complete authoritative discovery confirms no suitable field exists, report that missing field and assess whether the caller could create it. Separate account/organization ownership eligibility from token permissions. Never create a field as a permission test.
6. If field discovery is forbidden, stop the absence/creation branch: report the missing read access when established, otherwise unknown. Do not recommend creation as if absence had been proven.

A deleted mapping with another compatible field available leads to selection, not unnecessary creation. Incompatible existing options are reported without silently rewriting a shared field. Disabled complexity retains mappings and remote estimates.

## Permission evidence

Use authenticated API responses, documented permission requirements, available granted/accepted scope headers and repository access facts. Scopes constrain token access; being the account owner alone is not proof that a token can create fields. Fine-grained tokens and app credentials may not expose classic scopes, so do not label absent headers as missing permissions. When non-mutating evidence cannot establish write access, report unknown with a bounded next check rather than inventing success or performing a test write.

For personal-account native fields, GitHub currently documents classic/OAuth `read:user` for listing definitions and `user` for creating them; fine-grained credentials use user Issue Fields read/write. Organization requirements differ. Pin recovery advice to the detected owner/credential type and requested operation; do not ask everyone for every scope. Credential refresh is always an explicit user action, never part of Doctor. Explain broader scope implications and narrower supported alternatives.

Sources: [personal fields API](https://docs.github.com/en/rest/users/issue-fields), [organization fields API](https://docs.github.com/en/rest/orgs/issue-fields), [OAuth scope evidence](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/scopes-for-oauth-apps).

## Results and acceptance

Read-only local `doctor` owns the configuration/capability assessment. Ticket Doctor may reuse the same collector/validators, without duplicate requests or a different policy. Preserve existing result/exit compatibility, or explicitly version a breaking change. Each finding carries a stable ID, operation, status, evidence/uncertainty and exact implemented recovery syntax in text and JSON. Never return tokens, raw auth output or private configuration. All checks remain independent; report partial results honestly.

Fixtures cover disabled complexity; healthy existing field with no creation privileges; existing field without value-write access; unmapped configuration with a reusable field; confirmed missing field with and without creation permission; forbidden discovery; incomplete pagination; incompatible/deleted mappings; and credentials whose permissions cannot be proven non-destructively. Assert that creation-permission checks never run when a usable field exists, and no remote/local writes or auth refresh occur. This is a separate implementation slice, not authorization to broaden credentials or fabricate missing evidence.
