# Local evidence storage, isolation and recovery experiment (#203)

## Contents

- [Summary and recommendation](#summary-and-recommendation)
- [What was built](#what-was-built)
- [Method](#method)
- [Expected versus observed](#expected-versus-observed)
- [Measurements](#measurements)
- [Findings](#findings)
- [JSON files or a database](#json-files-or-a-database)
- [Existing code compared](#existing-code-compared)
- [Source evidence](#source-evidence)
- [Limitations](#limitations)
- [Reproduce](#reproduce)

## Summary and recommendation

**Recommendation: narrow.** If a production store is built, use one JSON file per context (host, repository, authenticated login, collection profile) under the per-user cache directory from `env-paths`, written with the lock, verify and rename sequence tested here, with age-based lock breaking disabled. Do not add a database. Do not build the store at all until #202's "narrow" result has been measured inside `briefing --last` and shows that reuse saves enough to matter: storage is the easy part, and nothing here shows that stored evidence is worth keeping.

Reasons:

1. **Isolation by directory and envelope works.** Each context gets its own directory named by a digest of its canonical identity, and the envelope repeats the identity. Every cross-context read (other host, repository, login or profile) was a `no-cache` miss; a file copied into another context's directory was a `context-mismatch` miss; an unknown login could neither read nor write.
2. **Atomic replace held on macOS and Linux.** About 6,500 reads (macOS) and 1,550 reads (Linux) taken while another process replaced the snapshot 100 times all returned a complete, valid snapshot. No read was torn or failed. Processes killed at each of the nine write steps always left a readable snapshot: the previous one if killed before the rename, the new one after.
3. **Concurrent writers lost nothing.** Two and four separate processes doing read-modify-write under the lock ended with every record (50 of 50, 40 of 40) on both platforms. The writers really overlapped: the lock was found held 20 and 36 times on macOS, 2 and 10 times on Linux.
4. **Stuck locks are safe but blunt.** A crashed holder's lock is never removed. Every later writer waits the full five seconds, then misses (measured 5,014 ms macOS, 5,004 ms Linux), and keeps doing so until someone who knows the holder has stopped removes it. Readers are not blocked. This is the contract's rule, and in production it would need an operator-visible diagnostic or a liveness scheme, which is out of scope here.
5. **The common outcomes are distinguishable.** No snapshot, an empty snapshot with complete coverage, an empty snapshot with partial coverage, a truncated file, a corrupt file, a foreign or future schema, a future timestamp (clock rollback), an expired snapshot and an unreadable file each produce a different result. None of them is ever reported as empty evidence.
6. **It is cheap.** 256 synthetic records is 312 KB of JSON. A durable write took a median 13.4 ms on macOS and 2.6 ms on Linux; a read took 1.2 ms and 0.6 ms. On macOS about 10 ms of the write is the two fsync calls.
7. **A database adds nothing at this size.** See [JSON files or a database](#json-files-or-a-database).

What would move this to "adopt": a measured saving from #202-style reuse inside the real briefing path, a decision on how a stuck lock is surfaced to the user, and a Windows run of the runner (only the tests ran on Windows; see [Limitations](#limitations)).

## What was built

All under `doc/reports/examples/cache-experiments/`, beside the #202 files. Nothing is wired into the product, nothing writes to the default per-user cache, and nothing contacts GitHub.

- `storage.ts` is the model. `contextKey` canonicalises the host, repository, login and profile (lower case, trailing dot removed) and digests them with the schema and profile versions. An absent login, or an invalid host, repository or profile, yields no key and therefore no reuse. `loadSnapshot` returns `hit`, `empty` (with `coverageComplete`) or a `miss` with a reason. Stored evidence is always labelled `stored-unvalidated`, never fresh. It is a miss unless the caller confirms current access on this run. `storeSnapshot` runs mkdir, lock, read-previous, write-temp, fsync-temp, verify-temp, rename, fsync-dir and unlock. The lock is `acquireFileLock` from `src/config/filelock.ts` with `staleMs: Infinity` (never broken by age) and a 5,000 ms deadline. A refused rename (`EPERM`, `EACCES`, `EBUSY`) is retried up to five times. Every failure returns `not-written` with its step, and the previous snapshot stays in place. `applyObservation` merges an observation. It prunes unseen records only after a complete manifest, drops records older than 24 hours and evicts above 256, oldest first, and reports each removal. `cleanupExpired` examines at most 64 contexts. It cleans each one only while holding its lock without waiting, skips busy ones, and removes the directory with a non-recursive `rmdir` so that a writer arriving at the same moment keeps its files. `removeExperimentRoot` refuses unless the caller says all holders were joined.
- `storage-worker.ts` is a child process (run through `tsx`) for concurrent writers, a long-lived lock holder, a crash before a chosen step (`process.exit`, so no `finally` or cleanup runs) and a writer racing readers.
- `storage.test.ts` holds 29 tests on the real filesystem in temporary directories. They cover isolation, distinguishable misses, injected failures before each step, an injected Windows-style rename refusal, an unreadable file, an inaccessible directory (POSIX only), file modes, the age-based lock hazard, a live holder past the helper's 10-second stale age, a crashed holder, cleanup confirmation, two concurrent writer processes, readers during renames, a process killed at each step, retention, eviction and cleanup. Every path uses `node:path`.
- `storage-run.ts` is the runner. It repeats the scenarios with timing in a fresh temporary root and prints a `schemaVersion: 1, kind: cache-experiment` report with an expected-versus-observed table. It joins every child before removing the root, and preserves the root (printing its path) if the run failed.

## Method

The runner was run twice on 2026-11-14 at source revision `6e49779` plus the files in this PR (the Linux run predates two lint-only edits to the runner and worker that do not change behaviour):

- **macOS**: Darwin 27.2.0, Node 26.7.0, APFS on the internal disk, 30 iterations per size, 24.5 s in total.
- **Linux**: the `node:26` Docker image (Node 26.13.1) on Docker Desktop's LinuxKit VM (kernel 6.12.76), overlay filesystem, run as a non-root user, 30 iterations per size, 20.8 s in total. This is a virtual machine on the same Mac, not native Linux hardware.

**Windows** was not measured. The test file runs in CI on `windows-latest` (Node 26), so the tests that do not need POSIX permissions also run there. These include rename over an existing file, readers during renames, concurrent writer processes and processes killed at each step. On PR #381's first CI run (2026-11-14, run 43632250760) `storage.test.ts` passed on `windows-latest` with 27 tests run and the 2 POSIX-only tests skipped; it also passed on `ubuntu-latest`. That pass/fail result is the only Windows evidence.

The records are synthetic. Each one has a title, state, labels, assignees, recent comment excerpts, edges and, for PRs, a head SHA and checks, which comes to about 1.2 KB of JSON per record. Times are real wall-clock measurements on these machines. One run per platform is indicative, not a statistical study.

## Expected versus observed

All 40 rows matched on both macOS and Linux. Expected values were written into the runner before it was run.

| ID       | Scenario                                                     | Expected (= observed, both platforms)                   |
| -------- | ------------------------------------------------------------ | ------------------------------------------------------- |
| I1–I4    | read with a different host / repository / login / profile    | `miss:no-cache`                                         |
| I5       | same context, different letter case                          | `hit:3`                                                 |
| I6       | another context's file copied into this directory            | `miss:context-mismatch`                                 |
| I7 / I8  | unknown login: read / write                                  | `miss:unknown-context` / `not-written:unknown-context`  |
| I9       | caller reports repository access lost                        | `miss:access-not-confirmed`                             |
| C1       | no snapshot                                                  | `miss:no-cache`                                         |
| C2 / C3  | zero records, complete / partial coverage                    | `empty:0 complete` / `empty:0 partial`                  |
| C4 / C5  | zero-length file / first half only                           | `miss:truncated`                                        |
| C6       | invalid byte mid-file                                        | `miss:corrupt`                                          |
| C7       | NUL-filled file (lost data blocks)                           | `miss:corrupt`                                          |
| C8       | valid JSON, wrong shape                                      | `miss:corrupt`                                          |
| C9 / C10 | schemaVersion 2 / 0                                          | `miss:future-schema` / `miss:schema-mismatch`           |
| C11      | `observedAt` one hour ahead                                  | `miss:future-timestamp`                                 |
| C12      | read 24 h + 1 ms after the last success                      | `miss:expired`                                          |
| C13      | local clock rolled back two hours                            | `miss:future-timestamp`                                 |
| C14      | write over a damaged file                                    | written (previous `truncated`), then `hit:4`            |
| F-\*     | injected error before each of 7 steps (mkdir … rename)       | not-written at that step; previous intact; nothing left |
| L1       | write while a crashed holder's lock remains                  | `lock-timeout`; lock kept                               |
| L2       | lock file one day old, unknown holder                        | `lock-timeout`; lock kept                               |
| L3       | live holder whose lock looks 20 s old to the contender       | contender `lock-timeout`; holder written                |
| W2 / W4  | 2 × 25 / 4 × 10 read-modify-writes from separate processes   | 50 / 40 records                                         |
| R1       | reads during 100 replacements by another process             | no torn or failed reads                                 |
| E1       | 300 records offered                                          | 256 kept, 44 evicted                                    |
| E2 / E3  | partial / complete manifest lists 4 of 10                    | 10 kept, 0 pruned / 4 kept, 6 pruned                    |
| E4       | cleanup: expired; fresh with orphan temp; expired and locked | removed 1, temps 1, busy 1                              |

**Processes killed before each step** (both platforms identical; all exited 70 as intended):

| Killed before | Lock left | Temp left | Next read            |
| ------------- | --------- | --------- | -------------------- |
| mkdir, lock   | no        | no        | previous (2 records) |
| read-previous | yes       | no        | previous             |
| write-temp    | yes       | no        | previous             |
| fsync-temp    | yes       | yes       | previous             |
| verify-temp   | yes       | yes       | previous             |
| rename        | yes       | yes       | previous             |
| fsync-dir     | yes       | no        | new (7 records)      |
| unlock        | yes       | no        | new                  |

The previous file was byte-identical in every case before the rename. A crash after taking the lock always leaves it behind, and the next writer misses for five seconds per attempt until it is removed by hand (or by the runner after it has joined the crashed process).

## Measurements

Durable write (all nine steps) and read (`loadSnapshot`, parse and validate), 30 iterations each, in milliseconds:

| Records | Bytes   | macOS write median / p95 | macOS read median / p95 | Linux write median / p95 | Linux read median / p95 |
| ------- | ------- | ------------------------ | ----------------------- | ------------------------ | ----------------------- |
| 0       | 491     | 11.2 / 15.1              | 0.13 / 0.56             | 1.03 / 1.97              | 0.04 / 0.08             |
| 50      | 62,575  | 14.0 / 27.4              | 0.67 / 0.89             | 1.22 / 1.93              | 0.15 / 0.20             |
| 256     | 319,286 | 13.4 / 16.3              | 1.16 / 1.75             | 2.55 / 2.98              | 0.58 / 0.64             |

Median per step at 256 records: macOS fsync of the temp file 4.9 ms and fsync of the directory 4.8 ms, everything else under 1.2 ms; Linux fsync 0.43 and 0.29 ms. On Apple platforms libuv's `fsync` uses `F_FULLFSYNC`, which flushes the drive cache, so the macOS figure is the cost of real durability, not overhead in this code. Size grows linearly at about 1.2 KB per record. The 256-record cap therefore bounds one context at about 320 KB with these records. Real records with longer bodies would be larger; comment bodies should be excerpted or excluded.

Concurrency and locks:

| Measurement                                       | macOS                    | Linux                  |
| ------------------------------------------------- | ------------------------ | ---------------------- |
| 2 writers × 25: records, lock found held, overlap | 50/50, 20 times, 510 ms  | 50/50, 2 times, 43 ms  |
| 4 writers × 10: records, lock found held, overlap | 40/40, 36 times, 156 ms  | 40/40, 10 times, 59 ms |
| reads during 100 replacements (20 or 200 records) | 5,461 + 1,037, none torn | 1,317 + 229, none torn |
| crashed holder: write waited, result              | 5,014 ms, lock-timeout   | 5,004 ms, lock-timeout |
| live holder that looks 20 s old: contender waited | 5,016 ms, lock-timeout   | 5,001 ms, lock-timeout |

"Overlap" is the time during which every writer was still writing after the last had started. All writers waited for a common start time, so the counts show real contention, not sequential runs. No rename needed a retry on either platform.

Storage location reported by `env-paths` on this Mac: `~/Library/Caches/presidential-daily-briefing-nodejs/evidence`. On Linux the runner reported `~/.cache/presidential-daily-briefing-nodejs/evidence`. From the env-paths 4.0.0 source, Windows would use `%LOCALAPPDATA%\presidential-daily-briefing-nodejs\Cache\evidence` and Linux honours `XDG_CACHE_HOME`. The Windows path is read from the source, not observed.

## Findings

- **Isolation.** A per-context directory keyed by a digest, plus an envelope check, is enough. Canonicalisation matters: host and repository are case-insensitive on GitHub, and treating `Example/Repo` and `example/repo` as different would only waste space, while merging different logins would leak visibility. Logins are lower-cased. A renamed or transferred repository gets a new key, so it is a miss, not reuse. The key covers the authorization context only as far as the login. Permission changes for the same login are not visible to storage, so reads require the caller to confirm access on this run (I9).
- **Concurrency.** The lock plus read-previous under the lock makes read-modify-write safe across processes. Without the re-read under the lock, a writer would overwrite records added by another since it last read (not run as a separate scenario; this follows from whole-file replacement). Atomic rename alone keeps files whole but does not prevent lost updates.
- **Age-based lock breaking is unsafe here, as the contract says.** In the test, `acquireFileLock` with the update cache's `staleMs: 10_000` took over a lock that looked one day old, while `staleMs: Infinity` never did. The same holds for a live holder: a contender whose clock runs 20 s ahead would break a lock still in use. With `Infinity`, the five-second deadline is the only bound.
- **The cost of never breaking locks** is that a crash between lock and unlock blocks every later write for that context until the lock is removed by someone who knows the holder is gone. Reads keep working and serve the previous snapshot (labelled stored and unvalidated). A production design needs either an explicit `doctor`-style removal with the holder PID shown, or a liveness scheme (heartbeat or OS lock). Both are outside this experiment.
- **No cache, empty and corrupt.** Distinguishing them needs two things: coverage stored beside the records, so that an empty snapshot can say whether it is authoritative, and classification of read errors (`ENOENT` versus others) and parse errors. The truncated-versus-corrupt split is a heuristic on V8's `JSON.parse` messages (an error at the end of the text means truncated). Both are misses, so a misclassification changes only the diagnostic.
- **Clock handling.** A stored time more than 60 s ahead of the local clock is a miss (clock rollback or a future write), and cleanup treats it as expired. A snapshot older than 24 hours is a miss even if the file is intact.
- **Permissions.** Context directories are created `0700` and snapshots `0600` (verified on POSIX). Windows ignores these modes; per-user isolation there comes from `%LOCALAPPDATA%` ACLs, which was not tested. Making a directory inaccessible (POSIX, non-root) gave an `unreadable` read miss and a failed write. The previous snapshot was intact once access returned.
- **Cleanup.** Expired contexts and orphan `*.tmp` files can be removed safely only under the context lock. A context with a stuck lock is reported as busy and kept, so a crashed holder's directory is never cleaned automatically. The per-call bound (64 contexts) defers the rest and reports how many.
- **Not exercised.** Power loss after a rename but before the directory fsync (only process kills were tested), disk-full errors other than those injected, network filesystems, and antivirus or indexer interference on Windows.

## JSON files or a database

Recommendation: JSON files, one per context. Reasons:

- **Size.** The contract caps a context at 256 records. At about 320 KB, a whole-file rewrite costs 2.6–13 ms, dominated by fsync, and a full read costs 0.6–1.2 ms. A database's advantage is in-place partial update and indexed queries over large data, and neither applies at this size.
- **Concurrency.** Writers are rare (one per triage run) and the lock already serialises them. SQLite would replace this lock with its own file locking and journal (WAL or rollback). That brings its own Windows and network-filesystem caveats and adds `-wal`/`-shm` side files to clean up, without removing the need to reason about crashed writers.
- **Dependencies and stability.** `node:sqlite` is built into Node 26 (it loaded here and exports `DatabaseSync`), so no package is needed. But the contract excludes a mandatory database, the CI matrix includes a FreeBSD trial build, and JSON needs nothing new.
- **Inspectability and recovery.** A JSON snapshot can be read, diffed and deleted by hand. Recovery from any damage is "miss, then full read". A damaged database needs its own recovery path.
- **Not measured.** I did not benchmark `node:sqlite`. The argument above rests on the measured JSON costs being small, not on a measured database comparison.

## Existing code compared

These observations come from reading the code; none of it was changed:

- `atomicJson` in `src/cli.ts` (used for `--cache` and `--checkpoint`) writes to `${path}.${pid}.tmp` without a lock or fsync and renames it. Two writes to the same path from one process would share a temp name, and concurrent processes can lose updates (last writer wins). That is acceptable for an explicit single-user file but not for a shared store.
- `src/updates/updatecache.ts` uses a unique temp name with `wx` and a lock with `staleMs: 10_000`. For a store holding evidence that lock setting is unsafe (see above). It does not fsync, and it treats every bad file as absent without saying why. The update check can afford that; evidence reuse should report the reason.
- `cachedSnapshot` throws on a bad file and `checkpointSince` throws on anything except `ENOENT`. For an explicitly named offline file that is the right behaviour, and it differs deliberately from a disposable cache, where a bad file is a miss.
- `env-paths` does not ignore a relative `XDG_CACHE_HOME`, although the XDG specification says it should. A production store should check that the root it is given is absolute.

## Source evidence

- POSIX `rename()`: when `new` exists, "a directory entry named new shall remain visible to other threads throughout the renaming operation and refer either to the file referred to by new or old before the operation began." https://pubs.opengroup.org/onlinepubs/9799919799/functions/rename.html (accessed 2026-11-14).
- Microsoft, `MoveFileExW`: `MOVEFILE_REPLACE_EXISTING` replaces an existing destination file "provided that security requirements regarding access control lists (ACLs) are met". Renaming needs delete permission on the file or delete-child permission on the directory. The page makes no atomicity guarantee. https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-movefileexw (accessed 2026-11-14).
- libuv `src/win/fs.c`: `fs__rename` calls `MoveFileExW(..., MOVEFILE_REPLACE_EXISTING)`, and `fs__open` opens files with `FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE` "to match UNIX semantics", so a Node reader does not block a Node rename. Other programs (antivirus, indexers) may open files without delete sharing, which is why the rename is retried. https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c (accessed 2026-11-14).
- libuv `src/unix/fs.c`: on Apple platforms `uv__fs_fsync` uses `fcntl(F_FULLFSYNC)` because "Apple's fdatasync and fsync explicitly do NOT flush the drive write cache". https://github.com/libuv/libuv/blob/v1.x/src/unix/fs.c (accessed 2026-11-14).
- XDG Base Directory Specification: `XDG_CACHE_HOME` defaults to `$HOME/.cache`, and a relative path should be considered invalid and ignored. https://specifications.freedesktop.org/basedir/latest/ (accessed 2026-11-14).
- `env-paths` 4.0.0 (`node_modules/env-paths/index.js`, read 2026-11-14) gives macOS `~/Library/Caches/<name>`, Windows `%LOCALAPPDATA%\<name>\Cache` and Linux `$XDG_CACHE_HOME/<name>`, with a default `-nodejs` suffix.
- Prior work: `doc/reports/incremental-cache-research.md` (#198), `doc/reports/cache-refresh-experiment.md` (#202) and the contract `doc/design/cache-experiments.md`.

## Limitations

- **Windows was not measured.** Only the CI test run on `windows-latest` covers it, and it gives pass or fail, not timings or read counts. The POSIX permission tests are skipped there, and Windows ACL isolation was not tested.
- **Linux ran in a Docker Desktop VM** on overlayfs, not on native hardware or ext4. Its fsync times in particular may not represent a real disk.
- One run per platform, 30 iterations per size, on one machine. Times are indicative.
- Crashes were simulated by `process.exit` before a step. That stops the process but not the OS, so writes already handed to the kernel still land. Power loss and kernel crashes were not tested, and neither was the window between rename and directory fsync.
- Records are synthetic. Real issue and PR bodies vary widely in size.
- The truncated-versus-corrupt classification depends on V8 error messages and could change with Node versions. Both outcomes are misses either way.
- Stored evidence is never revalidated here. Freshness, validators and reconciliation belong to #202, and this store only labels evidence `stored-unvalidated`.
- No live GitHub run, by design: storage does not need the network, and the contract forbids further probes while quota is limited.

## Reproduce

From the repository root after `npm ci`:

```sh
# Tests (real filesystem in temporary directories; spawns child processes)
npx vp test run doc/reports/examples/cache-experiments/storage.test.ts
npx tsc -p doc/reports/examples

# Measured report (about 25 s; includes two real five-second lock waits)
npx tsx doc/reports/examples/cache-experiments/storage-run.ts [--iterations 30]

# Linux in Docker, as measured here. Run it from a disposable COPY of the repository without
# node_modules: the command installs Linux dependencies and changes file ownership in /w.
docker run --rm -v "$COPY":/w -w /w node:26 bash -c \
  "npm ci --ignore-scripts && useradd -m u && chown -R u /w && \
   su u -c 'npx tsx doc/reports/examples/cache-experiments/storage-run.ts'"
```

The runner creates its own temporary root and removes it after joining every child process. Pass `--root DIR` (empty) to keep the files for inspection.
