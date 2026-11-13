# Signed workflow records: value beyond GitHub identity (#239)

Research for #239, a bounded initial spike under [research stages](../design/research-stages.md), building on the [#155 workflow message trust report](workflow-message-trust.md), the [comment-marker authority contract](../design/workflow.md#focused-handoff-62) (#212, #214, #215/#216) and the [delivery-record authority rules](../design/delivery-lifecycle.md#records-storage-versioning-and-authority). Research and documentation only: no runtime code, no key generation, no host configuration, no live record signing, no paid model trials and no permission changes.

**Recommendation (Section 8): revisit under named triggers.** Do not build signing now. Signatures would add one thing the current baseline lacks, cryptographic binding of a record to a _specific key holder_ (and so to a specific installation or agent, if keys are not shared). Today that gap has no concrete exploit that the GitHub author/write-permission check does not already close or that signing would actually close, because all agents share one GitHub account, one host and, in practice, would share key custody too.

## Contents

1. [Provenance and method](#1-provenance-and-method)
2. [Current baseline (facts)](#2-current-baseline-facts)
3. [Threat model](#3-threat-model)
4. [What signatures would and would not solve](#4-what-signatures-would-and-would-not-solve)
5. [Key discovery and trust options](#5-key-discovery-and-trust-options)
6. [Formats, libraries and measured sizes](#6-formats-libraries-and-measured-sizes)
7. [Design requirements if this is ever pursued](#7-design-requirements-if-this-is-ever-pursued)
8. [Recommendation](#8-recommendation)
9. [Uncertainties](#9-uncertainties)
10. [Proposed follow-ups (not filed)](#10-proposed-follow-ups-not-filed)
11. [Decision brief for the owner](#11-decision-brief-for-the-owner)
12. [Sources](#12-sources)

## 1. Provenance and method

- **Researcher:** `kavya_sabbagh`, a Claude Code agent running Anthropic's Claude Opus 5.5 (`claude-opus-5-5`); harness version not recorded.
- **Environment:** macOS (Darwin 27.2.0), Node v26.7.0, 2026-11-13, this repository at `origin/main` `88f54ca`.
- **Time spent:** about one hour of agent time, within the ticket's bound.
- **Keys:** none generated, reused or published. The task brief allowed ephemeral in-memory Ed25519 keys for size measurement, but the ticket forbids key generation, so the stricter rule was followed. Sizes in Section 6 were instead computed structurally: Ed25519 public keys and signatures have fixed lengths (32 and 64 bytes, RFC 8032 §5.1.5–5.1.6), so zero-filled placeholders of those lengths give exact encoded sizes. The throwaway script lived only in the session scratchpad and was not committed.
- **Evidence levels:** code facts are _source-inspected_ at the commit above (file:line cited). Format and API facts are _documented_ from the primary sources in Section 12 (all retrieved 2026-11-13, HTTP 200). Nothing was signed or verified live.

## 2. Current baseline (facts)

| Control                      | Where                                                                                                               | What it establishes                                                                                                                                                                               |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub authentication        | GitHub itself; the tool reads `author{__typename login}` (`src/claims.ts:196-197`)                                  | Which GitHub account posted the comment. GitHub, not the tool, authenticates it                                                                                                                   |
| Account type                 | `src/claims.ts:216-218`                                                                                             | Bots and apps (`__typename !== "User"` or a `[bot]` login) never gain marker authority                                                                                                            |
| Authorization (current)      | `src/github.ts:706-710` (`writePermissions`), `src/github.ts:720-751` (`permissionLookup`)                          | The author currently has write, maintain or admin, from `GET /repos/{o}/{r}/collaborators/{u}/permission`; one request per login per run; any error, 404, rate limit or foreign body is `unknown` |
| Edit control                 | `src/claims.ts:229-244` (`commentAuthority`)                                                                        | An edited comment counts only if the last editor is the author or also write-capable; unreadable edit history or editor is `unknown`                                                              |
| Fail-closed classification   | `src/claims.ts:206-228` (`actorAuthority`), `src/delivery.ts:338-346`, `:495-530`                                   | `untrusted` is ignored with a warning; `unknown` makes the fold unknown and refuses with `MARKER_UNVERIFIED`; never "absent"                                                                      |
| Injected trust boundary      | `src/delivery.ts:86-91` (`TrustDecision`, `markerTrust`)                                                            | Callers depend on an interface; the implementation can be replaced without changing them                                                                                                          |
| Repository and issue binding | `src/delivery.ts:357-366`                                                                                           | A delivery record copied to another repository or issue is rejected as `foreign`                                                                                                                  |
| Ordering                     | `src/delivery.ts:347-352`; [delivery lifecycle](../design/delivery-lifecycle.md) "Responsibility-transfer ordering" | Records fold in GitHub comment order (creation time, then comment id), never a caller-supplied timestamp; a stale handoff is rejected `HANDOFF_STALE`                                             |
| Retry identity               | `src/delivery.ts:111-128` (`deliveryOpId`)                                                                          | A SHA-256 of repository, issue, op, deliverables, agent and `issuedAt`. It is a deterministic **identifier**, not authentication: anyone can compute it                                           |
| Agent name                   | [workflow contract](../design/workflow.md#focused-handoff-62), #155 §4.7                                            | Reported, not authenticated. All agents here post through one GitHub account                                                                                                                      |

## 3. Threat model

### Assets

- **A1. Workflow state:** claims, releases/handoffs, needs-human markers and delivery records (membership, responsibility, `complete`), which drive label changes and issue closure.
- **A2. The decision trail:** who did what, used by Ticket Doctor, catch-up and owners.
- **A3. The GitHub token and account** that agents post through.

### Actors

- **Outsiders:** any signed-in GitHub user who can comment on the public repository.
- **Read/triage collaborators:** can comment and (triage) set labels, but are not write-capable.
- **Write-capable humans:** the owner and any maintainers.
- **Agents:** several harnesses (Claude Code, Codex, others) on the owner's machines, all using the owner's authenticated `gh`.
- **Apps and bots:** Codex connector and other integrations.
- **GitHub itself:** trusted platform; its compromise is out of scope.

### Trust boundaries

1. Public comment box → tool parser (anyone can write bytes that look like a marker).
2. GitHub account → GitHub permission model (who may write; GitHub authenticates).
3. Agent process → shared GitHub token (any agent with the token is the account).
4. Agent process → its own text output (an LLM can write an incorrect but well-formed record).

### Six properties, kept distinct

| Property               | Meaning                                              | Baseline today                                                                                                         |
| ---------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| GitHub authentication  | Which account posted                                 | **Yes**, by GitHub                                                                                                     |
| Authorization          | That account may drive writes now                    | **Yes**, current permission only (no historical permission exists in GitHub, #155 §3)                                  |
| Claimed agent identity | Which agent (`kavya_sabbagh`, …) wrote it            | **No**. Reported only; one shared account                                                                              |
| Machine provenance     | Which host or installation produced it               | **No**                                                                                                                 |
| Content integrity      | The bytes read equal the bytes the author wrote      | **Partly**: GitHub stores the content; edits are visible and editor-checked; no end-to-end check independent of GitHub |
| Replay protection      | A genuine record cannot be reused elsewhere or later | **Partly**: repository/issue binding, comment order, predecessor checks; a write-capable user can still re-post a copy |

A checksum (such as `opId`) authenticates nobody; signing does not encrypt or hide content.

### Concrete failure scenarios

| #   | Scenario                                                                                         | Baseline outcome                                                                                                            |
| --- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| S1  | Outsider pastes a byte-exact delivery record or release marker                                   | Ignored as untrusted (`src/claims.ts:224-227`). **Closed.**                                                                 |
| S2  | Outsider edits nothing but a write-capable maintainer edits an agent's record                    | Editor is write-capable, so trusted. Visible as an edit. Matches the authority rule by design                               |
| S3  | Agent A, on the shared account, posts a handoff or `complete` naming agent B                     | Trusted: the account is write-capable. **Open**: agent identity is reported only                                            |
| S4  | A buggy or prompt-injected agent writes a well-formed but false record (wrong PR, wrong outcome) | Trusted. **Open**, mitigated only by fresh-evidence checks (e.g. `complete` re-reads live PR state)                         |
| S5  | Genuine record copied to another issue or repository                                             | Rejected `foreign` for delivery records (`src/delivery.ts:357-366`). Closed for that kind                                   |
| S6  | Genuine record re-posted later on the same issue by a write-capable account                      | Trusted as a new record in the new position; predecessor checks reject stale handoffs, but a re-posted `submit` folds again |
| S7  | GitHub permission lookup fails or is rate-limited                                                | `unknown`, refused `MARKER_UNVERIFIED`. Availability loss, not forgery                                                      |
| S8  | Collaborator loses write access; old records are read later                                      | Judged on current permission; their old records stop counting (#155 §4.1). Fails closed                                     |
| S9  | The shared token leaks                                                                           | Attacker is the account: every check passes. **Open**                                                                       |
| S10 | Offline audit: prove later, without GitHub, who wrote a record                                   | Not possible; the baseline needs live GitHub reads                                                                          |

## 4. What signatures would and would not solve

### Would solve (only under the stated conditions)

- **S3, claimed agent identity**, if and only if each agent or installation holds its **own** private key that no other agent can read, and an approved key list maps key to agent name. On one shared host user account, every agent process can read every key file, so this condition does not hold today.
- **S9, token leak alone**, if signatures are required in addition to write permission and the signing keys are stored separately from the token (for example in a hardware key or OS keychain the token thief cannot reach).
- **S10, offline proof**: a record plus a signature plus the approved key set (as it stood then) can be verified without GitHub, given trustworthy key-approval history.
- **Content integrity independent of GitHub**: an edit, by anyone, breaks the signature unless the editor re-signs.

### Would not solve

- **Shared keys or shared accounts.** A key shared by several agents identifies the group, exactly like today's shared account.
- **Authorized mistakes (S4).** A valid signature on a wrong record is a valid wrong record. Fresh-evidence checks remain the real defence.
- **Compromised signing host.** Malware or an injected agent on the signing host signs whatever it likes. With software keys on the owner's machine, S9 and host compromise coincide.
- **Correct-looking but false contents.** Signatures prove origin, not truth.
- **Authorization.** A valid signature from an approved key still needs the authority rule; signing does not replace `commentAuthority`.
- **Availability.** Signature checks add failure modes (missing key list, revoked key) rather than removing S7.
- **Ordering and replay on the same issue (S6).** A signed record re-posted by a write-capable account carries a valid signature. Only payload nonces/predecessor binding plus fold rules address that, and those already exist for handoffs without signing.
- **Confidentiality.** Signing does not encrypt; records stay public.

## 5. Key discovery and trust options

| Option                                                                                        | Facts                                                                                                                                                                                                                                                                                                                       | Assessment                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **GitHub-hosted signing keys** (`GET /users/{u}/gpg_keys`, `GET /users/{u}/ssh_signing_keys`) | Public, unauthenticated read of the keys a user registered for commit signing. Keys are attached to the **account**. GitHub's commit-verification docs state that GitHub, not the reader, decides verified status for commits; for arbitrary comment payloads there is no GitHub verification, the tool would verify itself | Proves "a key this account registered". On a shared account this adds nothing over the author check, and whoever holds the token can register a new key (needs the account's key-write scope) |
| **Repository-approved keys** (a committed file such as `.github/triage-keys`, reviewed by PR) | Approval, rotation and revocation become reviewed commits; history gives "which keys were approved when"; the format can mirror OpenSSH `allowed_signers` (principal → key, with `namespaces=` and `valid-after`/`valid-before`)                                                                                            | The only option that can map key → **agent name** and give offline history. Costs: a reviewed change per agent/installation, and a policy for who may approve                                 |
| **Public OpenPGP directories** (keys.openpgp.org, SKS successors)                             | keys.openpgp.org publishes identity-bearing user IDs only after e-mail verification; it does not vouch for any GitHub or agent identity                                                                                                                                                                                     | Adds a third party and proves an e-mail address, not repository authority. Not recommended                                                                                                    |
| **Keyless (Sigstore / gitsign)**                                                              | Short-lived certificates bound to an OIDC identity, logged in a public transparency log                                                                                                                                                                                                                                     | Identity is still the GitHub (or other OIDC) account, so shared-account limits remain; adds network dependencies and public logging. Out of proportion here                                   |

### Lifecycle concerns (any option)

- **Approval:** who may add a key; repository-approved keys inherit PR review.
- **Rotation:** records signed by an old key must stay verifiable; key entries need validity intervals, not deletion.
- **Revocation:** a revoked key must invalidate records signed _after_ revocation, but GitHub comment time is the only clock, so "after" relies on GitHub anyway.
- **Loss:** a lost key blocks that agent until a new key is approved; an unsigned fallback reopens the gap.
- **Edited comments:** any edit invalidates the signature unless the editor re-signs; this must become `unknown` or `untrusted`, mirroring `src/claims.ts:236-243`.

## 6. Formats, libraries and measured sizes

### Formats (facts)

- **Ed25519** (RFC 8032): 32-byte public key, 64-byte signature, deterministic signing; Node supports it natively through `crypto.sign(null, data, key)` / `crypto.verify(null, …)` with no dependency (Node crypto docs). A bare signature has no algorithm, key id or domain field; a bare scheme must define those itself.
- **SSHSIG** (OpenSSH `PROTOCOL.sshsig`): a standard envelope carrying the public key, a mandatory non-empty **namespace** (domain separation), a hash algorithm and the signature; produced and checked by `ssh-keygen -Y sign|verify` against an `allowed_signers` file. Armoured output is base64 wrapped at 70 columns (OpenSSH `sshbuf-misc.c`).
- **OpenPGP** (RFC 9580): rich packet format with subpackets (creation time, issuer fingerprint), keyrings, expiry and revocation certificates. `openpgp.js` is the maintained JavaScript implementation; `gpg` is the reference tool. Highest complexity.
- **Libraries:** Node built-in `crypto` (Ed25519) needs no new dependency, consistent with "Node built-ins and `gh`" in AGENTS.md. `@noble/ed25519` is a small audited pure-JS alternative but unnecessary given Node 26. SSHSIG verification in-process would need either `ssh-keygen` on PATH (not guaranteed on Windows) or a careful parser on top of Node crypto. No cryptography should be invented, truncated or shortened (for example, truncating the 64-byte signature or using a keyed checksum as a signature).

### Measured sizes (structural computation, Section 1)

| Item                                                                | Bytes | Kind          |
| ------------------------------------------------------------------- | ----: | ------------- |
| Ed25519 signature, binary                                           |    64 | raw           |
| as hex                                                              |   128 | raw, encoded  |
| as base64 (padded)                                                  |    88 | raw, encoded  |
| as base64url (unpadded)                                             |    86 | raw, encoded  |
| JSON envelope `{"alg":"ed25519","kid":"SHA256:<43>","sig":"<86>"}`  |   171 | enveloped     |
| SSHSIG blob, binary, namespace `github-triage-record`               |   190 | enveloped     |
| SSHSIG armoured (`-----BEGIN SSH SIGNATURE-----`, 70-column base64) |   318 | enveloped     |
| Sample `submit` delivery record JSON (one PR)                       |   496 | payload       |
| Same, as an unsigned marker comment                                 |   531 | payload       |
| Same, with the JSON envelope embedded                               |   709 | payload + sig |

OpenPGP detached signatures were not computed: their size depends on which subpackets the signer adds, so an exact figure would need a real signature. GitHub's comment limit (65,536 characters) is not a constraint at any of these sizes; the cost is human readability of the comment, not length.

## 7. Design requirements if this is ever pursued

These are constraints for a later design, not a design.

1. **Canonical payload.** Sign bytes, not a re-serialised object: either sign the exact UTF-8 marker body as posted, or adopt RFC 8785 (JSON Canonicalization Scheme). Never sign a pretty-printed or reparsed form.
2. **Binding.** The signed payload includes repository, issue number, `op`, `opId`, agent name, the predecessor record id for transfers, and a domain string (the SSHSIG namespace or an equivalent prefix), so a signature cannot be reused for another repository, issue, operation or protocol.
3. **Authority stays first.** Signature verification is an additional input to the existing `TrustDecision` boundary (`src/delivery.ts:86-91`); it never replaces the write-permission check.
4. **Fail closed, by the same table.** Missing key list, unreadable signature or unknown key → `unknown`; a key known to be revoked or for another agent → `untrusted`, mirroring `src/delivery.ts:495-530`.
5. **Edits.** Any edit invalidates the signature; the record becomes `unknown` until re-signed or voided.
6. **Caching and offline proof.** The approved key set is read from the repository at a known commit; verification results may be cached per run only, like permissions (`src/github.ts:713-751`). Offline audit needs the key file history, not a separate key server.
7. **Deployment and UX.** One key per installation stored outside the repository and outside the token's reach; setup and Doctor checks per harness on Windows, macOS and Linux; an explicit migration story for existing unsigned records (they remain at today's trust level, not "unsigned therefore forged").

## 8. Recommendation

**Revisit under named triggers; do not pursue a design now.** This matches the owner rationale on #239: the rules-based workflow is not yet proven, and signing must not delay it.

Reasons (each traceable to Sections 3–4):

- The attacks that matter from outside (S1, S5) are already closed by GitHub authentication, the write-permission rule and repository/issue binding.
- The open gaps (S3, S4, S9) are either not solved by signing (S4) or solved only if each agent has a private key no other agent can read (S3, S9). On one host account sharing one `gh` token, that condition does not hold, so signing would add key management without moving the trust boundary.
- A cheaper non-cryptographic step closes most of S3 if it ever matters: a separate GitHub machine account per agent or installation, which the current author check already understands.

**Triggers to revisit** (any one, together with a useful running system to protect):

1. Agents run as separate OS users or on separate hosts with isolated key storage, and agent attribution affects authority (for example, per-agent permissions).
2. A concrete incident or near-miss where one agent's records were attributed to another and fresh-evidence checks did not catch it.
3. A requirement to verify the workflow trail offline or after leaving GitHub.
4. Untrusted or third-party agents are allowed to write through a shared write-capable account or app.

## 9. Uncertainties

- Whether agents will stay on one shared GitHub account (owner question below). This decides most of the value.
- SSHSIG verification on Windows without `ssh-keygen` was not checked; an in-process verifier would need its own review.
- OpenPGP signature sizes were not measured (Section 6).
- No live signature was produced or verified, so the sizes are structural and the library notes are documented, not exercised.
- GitHub's per-user signing-key endpoints were checked for existence (HTTP 200), not exercised against this account.

## 10. Proposed follow-ups (not filed)

All low priority and deferred; none is authorised by this report and each would need an owner discussion first.

1. **Per-agent GitHub machine accounts (research).** Cost, ToS fit and permission setup of one account per agent or installation, as the non-cryptographic route to authenticated agent identity under the existing `commentAuthority`.
2. **Same-issue replay of non-transfer records (research).** Whether a re-posted trusted `submit` or `attach` can change the fold harmfully (S6), and whether `opId` deduplication already covers it. This is independent of signing.
3. **Signed records bounded design (only if a trigger in Section 8 fires).** Repository-approved Ed25519 keys via Node crypto or SSHSIG, following Section 7.

## 11. Decision brief for the owner

- **Question:** do signed workflow records solve a real remaining problem?
- **Answer:** not today. Outsiders are already stopped by GitHub author and write-permission checks. What remains, one agent posing as another on the shared account, and agents writing wrong-but-valid records, is respectively not fixed by signing unless each agent has its own isolated key, and not fixable by signing at all.
- **Cost if pursued:** key storage per installation on three platforms, an approved-key file with rotation and revocation, edit and migration rules, and about 170–320 extra bytes per record.
- **Recommendation:** revisit only when agents get isolated identities (separate OS users, hosts or GitHub accounts) _and_ attribution starts to carry authority, or after a concrete misattribution incident, or if offline audit becomes a requirement.
- **Decision needed now:** none. One question is posted on #239 about whether shared-account operation is the long-term model.

## 12. Sources

All retrieved 2026-11-13.

- GitHub REST, GPG keys for a user: https://docs.github.com/en/rest/users/gpg-keys
- GitHub REST, SSH signing keys for a user: https://docs.github.com/en/rest/users/ssh-signing-keys
- GitHub, about commit signature verification: https://docs.github.com/en/authentication/managing-commit-signature-verification/about-commit-signature-verification
- GitHub REST, collaborator permission: https://docs.github.com/en/rest/collaborators/collaborators
- RFC 8032, Edwards-Curve Digital Signature Algorithm (EdDSA): https://www.rfc-editor.org/rfc/rfc8032
- RFC 9580, OpenPGP: https://www.rfc-editor.org/rfc/rfc9580
- OpenSSH `PROTOCOL.sshsig` (rev 1.5, 2026-10-10): https://raw.githubusercontent.com/openssh/openssh-portable/master/PROTOCOL.sshsig
- OpenSSH `sshbuf-misc.c` (`sshbuf_dtob64`, 70-column wrap): https://raw.githubusercontent.com/openssh/openssh-portable/master/sshbuf-misc.c
- Node.js crypto API: https://nodejs.org/api/crypto.html
- OpenPGP.js: https://github.com/openpgpjs/openpgpjs
- noble-ed25519: https://github.com/paulmillr/noble-ed25519
- keys.openpgp.org, about: https://keys.openpgp.org/about
- Sigstore documentation: https://docs.sigstore.dev/ and gitsign: https://github.com/sigstore/gitsign
