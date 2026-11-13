# TOML library recommendation

Research date: 2026-11-13. Recommend **smol-toml** for the first implementation; an equivalent maintained library satisfying the preservation tests is an engineering choice. This is not approval to edit live identity data or a claim that the application already includes the dependency.

## Evidence and comparison

Official npm metadata reports smol-toml 1.9.1, BSD-3-Clause, Node >=18 and no runtime dependencies, with approximately 140 KB unpacked. Its upstream project supplies parsing and serialization and documents TOML 1.1 support. This fits the project's current Node LTS/TypeScript architecture. By comparison @iarna/toml 2.2.5 has no runtime dependencies and ISC licensing, but its registry modification date was 2023-07-15 versus 2026-10-09 for smol-toml. Recency alone is not a correctness or security guarantee.

Sources: [smol-toml upstream](https://github.com/squirrelchat/smol-toml), [smol-toml registry](https://www.npmjs.com/package/smol-toml), [@iarna/toml upstream](https://github.com/iarna/iarna-toml). Recheck the selected release, API and lockfile at implementation.

## Bounded scratch verification

Installed smol-toml 1.9.1 in a disposable directory, outside the repository and without application dependency changes. A parse/change/stringify/reparse assertion added one selected agent's triage_role while preserving existing names, generic role, unrelated keys, arrays, another agent, a quoted dotted entry key, and integer/float value types. Parsing used integersAsBigInt=true and serialization numbersAsFloat=true, following the library's type-preservation guidance. Synthetic values only; no private config was printed or modified.

This is limited plausibility evidence, not full round-trip coverage. In particular the serializer **does not preserve comments** and normalizes layout. Its default numeric/date behavior also needs explicit scrutiny before rewriting arbitrary unknown values. Preserve unknown keys rather than rebuilding a whitelist, avoid unsafe object merging, and test large integers, local/offset dates/times, quoted keys, malformed files and concurrent writes. Use a syntax-preserving editing approach if comment/layout preservation is required; do not claim a basic parser provides one.

## Handoff

Select/pin the maintained parser in the normal implementation PR, justify any equivalent alternative, and retain the complete identity/config service validation and filesystem boundary. This library question no longer requires an owner decision. None of this requires an external identity service or communications platform.
