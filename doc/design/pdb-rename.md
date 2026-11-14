# Presidential Daily Briefing rename

Owner decision, 2026-11-14. Delivery tickets #315–#320. The owner renamed the existing GitHub repository during this session; its canonical name is now `trebizondoculpepper/presidential-daily-briefing`. Preserve its history and immutable repository identity.

## Names and rationale

The product is **Presidential Daily Briefing**, replacing GitHub Triage. The primary executable is **`pdb`**, with **`pdb-mcp`** for the MCP server. The npm package is **`@trebizondoculpepper/presidential-daily-briefing`**. The owner's final GitHub slug and npm package both use hyphens. Installation, version/update notices, generated recovery commands, current documentation, server identification and release metadata must agree.

This is a naming/distribution migration. It must not rewrite issue history, discard persisted workflow receipts, change action authority or weaken mutation safeguards. Datalog default adoption is the separate mission #326 and should be included in the verified source for the first renamed release when ready.

## Classified occurrence map

This repository uses its own ticket/toolchain rather than introducing another workflow framework. The following map is the reviewable bulk-edit inventory; the owner has authorized the rename and its publication.

| Category            | Treatment                                                                                             | Boundary                                                                                                                                            |
| ------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Code symbols        | Rename product identifiers where externally meaningful; retain neutral `triage` domain/module symbols | No unnecessary semantic refactor                                                                                                                    |
| Import paths        | Update references for deliberately moved active documents/modules                                     | Keep working relative imports and generated `.js` specifiers                                                                                        |
| Filesystem paths    | Review individually                                                                                   | Preserve current checkout/worktrees, versioned settings and existing caches where compatibility requires; new app cache may use the product name    |
| Serialized keys     | Preserve                                                                                              | Existing schema versions, `triage_role`, `triage_*` MCP tool names, event kinds and hidden `github-triage:*` receipt markers are protocol contracts |
| CLI commands        | Rename                                                                                                | `pdb`/`pdb-mcp` are canonical; package may retain `github-triage`/`github-triage-mcp` bin aliases for migration, never advertise them as primary    |
| User-facing strings | Rename in current guidance                                                                            | Product heading, usage/errors, recovery commands, examples and package links use the new names                                                      |
| Tests and fixtures  | Update active command/package expectations; preserve historical protocol fixtures                     | Assert old receipts remain readable and new entry points work in isolated installs                                                                  |
| Logs and telemetry  | Review individually                                                                                   | Update visible executable prefixes; retain persisted event identifiers and legacy environment variables as compatibility aliases                    |

Keep historical reports, diary entries, released version references and old issue/PR URLs as historical evidence. Active repository links become canonical; old GitHub URLs may remain in historical text because GitHub redirects them. Never rewrite old signed/hashed record contents or identifiers to reflect branding.

The project-owned local identity file proposed in #319 is `pdb.toml` at the Git root, Git-ignored. Its separate migration imports matching `agent-inbox.toml` entries once and never writes back. The naming release must not falsely advertise that migration before it is implemented. Shared `.github/triage.toml` settings remain compatible until a deliberate command-mediated storage migration; renaming the product does not silently move user data.

## Repository and npm transition

1. Verify canonical GitHub repository identity, remotes, CI and open PRs after the owner's rename. Update active package repository/bugs URLs and publisher instructions to the final hyphenated GitHub slug.
2. Merge reviewed naming code with current-head required CI and a clean Codex or CodeRabbit review. Preserve all substantive review findings, even when the other provider is clean.
3. Validate packed contents, installed `pdb` and `pdb-mcp`, generated advice, update-check registry target, both role queues and rollback. Python also has a `pdb` module; the installed executable is selected by PATH. Do not remove or overwrite an unrelated executable silently.
4. Publish the new scoped package using the owner's existing npm account. npm cannot rename the existing package in place. First publication may require an authenticated maintainer bootstrap because trusted publisher configuration is package-specific. This one-time bootstrap is authorized for this rename: use only the exact reviewed/verified source, record gitHead and the chosen release version, and retain checks/packaging before publication. Never print credentials or commit local authentication.
5. Start the new package after the old package's last release without colliding with historical GitHub version tags. The old package reached `0.6.0` (tag `v0.6.0`) before the bootstrap, so the new package started at `0.7.0`. The source build placeholder is not release provenance. Subsequent releases use the normal explicit workflow and the new package's publication history. Configure/verify the new package's trusted publisher for the actual canonical repository and `publish.yml`; it does not inherit the old package's setup merely because the repository redirects.
6. Verify the registry's new name/version/gitHead, install it globally and exercise the actual bins. The owner decided to delete the old npm package during the rename session; on 2026-11-14 the registry still listed `@trebizondoculpepper/github-triage` 0.0.0-stage to 0.6.0. Do not deprecate, republish or recreate it automatically; removal is the owner's registry action. Existing local old-name installs can be replaced with the new package; old executable aliases remain compatibility entry points in the new distribution.

The local npm account is authenticated as `trebizondoculpepper` on the owner's machine. Authentication is an operational precondition, not a credential to place in this document or repository. Any interactive npm authentication challenge is completed by the owner.

## Publication record

On 2026-11-14 the owner bootstrapped `@trebizondoculpepper/presidential-daily-briefing@0.7.0` (npm `latest`, gitHead `33aa8bc5e68520608e0c70625f3a584ac7385f21`) from a clean checkout with an authenticated, 2FA-confirmed local publish; it carries no provenance. The `release` branch and GitHub release `v0.7.0` point at that commit. The owner then configured the package's trusted publisher (`trebizondoculpepper/presidential-daily-briefing`, `publish.yml`, no environment, publish and stage publish), and the Publish workflow published `0.7.1-next.1` (gitHead `51451645738ca5c95f011e14633b04dc0b8408bb`) on `next` with provenance. Later releases use the normal explicit workflow.

## Acceptance

The canonical GitHub repository, npm package, installed executables and current help/docs all identify Presidential Daily Briefing. CLI and MCP packaged smoke/parity checks pass on the reviewed source. Old workflow records and explicitly preserved serialized identifiers remain readable. Record publication/install evidence and remaining publisher administration accurately; a docs-only merge does not complete runtime, identity migration or publication tickets. The owner's deletion supersedes the earlier planned deprecation step.
