/**
 * Local evidence storage experiment runner (#203). No network, no GitHub, no credentials.
 *
 *   npx tsx doc/reports/examples/cache-experiments/storage-run.ts [--iterations N] [--root DIR]
 *
 * Runs every scenario against the real filesystem in a fresh temporary root (or an explicit
 * empty --root), using synthetic records, and prints one `schemaVersion: 1, kind:
 * cache-experiment` JSON report. Times are real measurements of this machine's filesystem; the
 * records are synthetic. Child processes are joined before the root is removed; if any could
 * not be joined, the root is preserved and its path reported.
 */
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { utimesSync, writeFileSync } from "node:fs";
import { homedir, release, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import {
  LOCK_FILE,
  LOCK_WAIT_MS,
  MAX_RECORDS,
  RETENTION_MS,
  SNAPSHOT_FILE,
  applyObservation,
  cleanupExpired,
  contextDir,
  contextKey,
  loadSnapshot,
  proposedRoot,
  removeExperimentRoot,
  storeSnapshot,
  syntheticObservation,
  type Context,
  type LoadResult,
  type WriteStep,
} from "./storage.js";
import { spawnWorker } from "./storage-worker.js";

interface Row {
  id: string;
  scenario: string;
  expected: string;
  observed: string;
  pass: boolean;
}

const ctx: Context = {
  host: "github.com",
  repository: "example/repo",
  authenticatedLogin: "agent",
  collectionProfile: "default",
};
const iso = (ms: number) => new Date(ms).toISOString();
const describe = (r: LoadResult) =>
  r.status === "miss" ? `miss:${r.reason}` : `${r.status}:${r.snapshot.records.length}`;
const fileOf = (root: string, c: Context = ctx) => {
  const k = contextKey(c);
  if (!k.ok) throw new Error(k.reason);
  return join(contextDir(root, k.key), SNAPSHOT_FILE);
};
const confirmed = (root: string, c: Context = ctx, now = Date.now()) =>
  loadSnapshot(root, c, { now: () => now, access: "confirmed" });
const put = (root: string, n: number, c: Context = ctx, now = Date.now()) =>
  storeSnapshot(root, c, () => syntheticObservation(n, iso(now)), { now: () => now });

function stats(values: number[]) {
  const s = [...values].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? NaN;
  const r = (x: number) => Math.round(x * 100) / 100;
  return {
    n: s.length,
    min: r(s[0] ?? NaN),
    median: r(q(0.5)),
    p95: r(q(0.95)),
    max: r(s.at(-1) ?? NaN),
  };
}

type Tally = { written?: number; notWritten?: Record<string, number> } | undefined;
const completed = (code: number | null, result: unknown, expected: number) => {
  const t = result as Tally;
  return (
    code === 0 &&
    t?.written === expected &&
    t.notWritten !== undefined &&
    Object.keys(t.notWritten).length === 0
  );
};

/** R1 verdict: the writer must have finished every replacement, and readers saw only whole files. */
export function rewriteVerdict(
  expected: number,
  code: number | null,
  result: unknown,
  seen: Record<string, number>,
): string {
  const reads = Object.values(seen).reduce((a, b) => a + b, 0);
  const torn = Object.keys(seen).filter((k) => k !== "hit:20" && k !== "hit:200");
  const writer = completed(code, result, expected)
    ? `writer exit 0, ${expected} written`
    : `writer exit ${String(code)}, ${JSON.stringify(result)}`;
  const readers =
    reads === 0
      ? "no reads taken"
      : torn.length
        ? `unexpected ${torn.join(",")}`
        : "no torn or failed reads";
  return `${writer}; ${readers}`;
}

/**
 * W verdict: every writer process must exit 0 having written all of its records, and the run
 * must show the writers really overlapped (all were writing at once, and the lock was found
 * held at least once). A sequential run is inconclusive, not a pass.
 */
export function writersVerdict(
  each: number,
  results: { code: number | null; result: unknown }[],
): string {
  if (!(results.length > 1 && results.every((x) => completed(x.code, x.result, each))))
    return `writers ${JSON.stringify(results)}`;
  const t = results.map(
    (x) => x.result as { lockBusy?: unknown; firstWriteAt?: unknown; lastWriteAt?: unknown },
  );
  const nums = (k: "lockBusy" | "firstWriteAt" | "lastWriteAt") =>
    t.map((x) => (typeof x[k] === "number" ? x[k] : NaN));
  const overlap = Math.min(...nums("lastWriteAt")) - Math.max(...nums("firstWriteAt"));
  const busy = nums("lockBusy").reduce((a, b) => a + b, 0);
  if (!(overlap > 0 && busy > 0))
    return `inconclusive: overlap ${overlap} ms, lock found held ${busy} times`;
  return `every writer exit 0 with ${each} written, none failed; overlapped`;
}

export async function runExperiment(base: string, iterations: number) {
  const rows: Row[] = [];
  const row = (id: string, scenario: string, expected: string, observed: string) =>
    rows.push({ id, scenario, expected, observed, pass: expected === observed });
  let n = 0;
  const fresh = () => {
    const r = join(base, `s${++n}`);
    mkdirSync(r, { recursive: true });
    return r;
  };

  // --- Size and latency -------------------------------------------------------------------
  const sizes: Record<string, unknown>[] = [];
  for (const count of [0, 50, MAX_RECORDS]) {
    const root = fresh();
    const writes: number[] = [];
    const reads: number[] = [];
    const steps: Partial<Record<WriteStep, number[]>> = {};
    let bytes = 0;
    for (let i = 0; i < iterations; i++) {
      const marks = new Map<WriteStep, number>();
      const t = performance.now();
      const r = await storeSnapshot(root, ctx, () => syntheticObservation(count, iso(Date.now())), {
        beforeStep: (s) => void marks.set(s, performance.now()),
        afterStep: (s) => void (steps[s] ??= []).push(performance.now() - (marks.get(s) ?? 0)),
      });
      writes.push(performance.now() - t);
      if (r.status !== "written") throw new Error(`write failed: ${JSON.stringify(r)}`);
      bytes = r.bytes;
      const t2 = performance.now();
      const l = await confirmed(root);
      reads.push(performance.now() - t2);
      if (l.status === "miss") throw new Error(`read failed: ${l.reason}`);
    }
    sizes.push({
      records: count,
      bytes,
      writeMs: stats(writes),
      readMs: stats(reads),
      writeStepMedianMs: Object.fromEntries(
        Object.entries(steps).map(([k, v]) => [k, stats(v ?? []).median]),
      ),
    });
  }

  // --- Isolation ---------------------------------------------------------------------------
  {
    const root = fresh();
    await put(root, 3);
    for (const [id, change] of [
      ["I1", { host: "ghe.example.com" }],
      ["I2", { repository: "example/other" }],
      ["I3", { authenticatedLogin: "someone" }],
      ["I4", { collectionProfile: "rich" }],
    ] as const)
      row(
        id,
        `read with different ${Object.keys(change)[0]}`,
        "miss:no-cache",
        describe(await confirmed(root, { ...ctx, ...change })),
      );
    row(
      "I5",
      "same context, different letter case",
      "hit:3",
      describe(await confirmed(root, { ...ctx, repository: "Example/Repo", host: "GITHUB.COM" })),
    );
    const other = { ...ctx, authenticatedLogin: "someone" };
    mkdirSync(join(fileOf(root, other), ".."), { recursive: true });
    copyFileSync(fileOf(root), fileOf(root, other));
    row(
      "I6",
      "another context's file copied in",
      "miss:context-mismatch",
      describe(await confirmed(root, other)),
    );
    row(
      "I7",
      "unknown login: read",
      "miss:unknown-context",
      describe(await confirmed(root, { ...ctx, authenticatedLogin: undefined })),
    );
    const w = await put(root, 1, { ...ctx, authenticatedLogin: undefined });
    row(
      "I8",
      "unknown login: write",
      "not-written:unknown-context",
      `${w.status}:${w.status === "written" ? "" : w.reason}`,
    );
    const lost = await loadSnapshot(root, ctx, { access: "lost" });
    row("I9", "repository access lost", "miss:access-not-confirmed", describe(lost));
  }

  // --- No cache / empty / damaged -----------------------------------------------------------
  {
    const root = fresh();
    const now = Date.now();
    row("C1", "no snapshot", "miss:no-cache", describe(await confirmed(root)));
    await put(root, 0, ctx, now);
    const empty = await confirmed(root, ctx, now);
    row(
      "C2",
      "zero records, complete coverage",
      "empty:0 complete",
      `${describe(empty)}${empty.status !== "miss" && empty.coverageComplete ? " complete" : " partial"}`,
    );
    const partialRoot = fresh();
    await storeSnapshot(partialRoot, ctx, () => syntheticObservation(0, iso(now), "partial"), {
      now: () => now,
    });
    const ep = await confirmed(partialRoot, ctx, now);
    row(
      "C3",
      "zero records, partial coverage",
      "empty:0 partial",
      `${describe(ep)}${ep.status !== "miss" && ep.coverageComplete ? " complete" : " partial"}`,
    );
    await put(root, 5, ctx, now);
    const good = readFileSync(fileOf(root), "utf8");
    const parsed = JSON.parse(good) as Record<string, unknown>;
    const damaged: [string, string, string, string][] = [
      ["C4", "zero-length file", "", "miss:truncated"],
      ["C5", "first half only", good.slice(0, Math.floor(good.length / 2)), "miss:truncated"],
      ["C6", "invalid byte mid-file", good.replace('"records":', '"records":x'), "miss:corrupt"],
      ["C7", "NUL-filled (lost data blocks)", "\u0000".repeat(good.length), "miss:corrupt"],
      [
        "C8",
        "valid JSON, wrong shape",
        JSON.stringify({ ...parsed, records: "nope" }),
        "miss:corrupt",
      ],
      [
        "C9",
        "future schemaVersion 2",
        JSON.stringify({ ...parsed, schemaVersion: 2 }),
        "miss:future-schema",
      ],
      [
        "C10",
        "older schemaVersion 0",
        JSON.stringify({ ...parsed, schemaVersion: 0 }),
        "miss:schema-mismatch",
      ],
      [
        "C11",
        "observedAt one hour ahead",
        JSON.stringify({ ...parsed, observedAt: iso(now + 3_600_000) }),
        "miss:future-timestamp",
      ],
    ];
    for (const [id, scenario, text, expected] of damaged) {
      writeFileSync(fileOf(root), text);
      row(id, scenario, expected, describe(await confirmed(root, ctx, now)));
    }
    writeFileSync(fileOf(root), good);
    row(
      "C12",
      "read 24 h + 1 ms after success",
      "miss:expired",
      describe(await confirmed(root, ctx, now + RETENTION_MS + 1)),
    );
    row(
      "C13",
      "local clock rolled back 2 h",
      "miss:future-timestamp",
      describe(await confirmed(root, ctx, now - 7_200_000)),
    );
    writeFileSync(fileOf(root), "{");
    const repaired = await put(root, 4, ctx, now);
    row(
      "C14",
      "write over a damaged file",
      "written(previous truncated) then hit:4",
      `${repaired.status}(previous ${repaired.status === "written" ? repaired.previous : "?"}) then ${describe(await confirmed(root, ctx, now))}`,
    );
  }

  // --- In-process injected failures -------------------------------------------------------
  for (const step of [
    "mkdir",
    "lock",
    "read-previous",
    "write-temp",
    "fsync-temp",
    "verify-temp",
    "rename",
  ] as WriteStep[]) {
    const root = fresh();
    await put(root, 2);
    const before = readFileSync(fileOf(root), "utf8");
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(9, iso(Date.now())), {
      beforeStep: (s) => {
        if (s === step) throw Object.assign(new Error("injected"), { code: "EIO" });
      },
    });
    const intact = readFileSync(fileOf(root), "utf8") === before;
    const left = readdirSync(join(fileOf(root), "..")).filter((x) => x !== SNAPSHOT_FILE);
    row(
      `F-${step}`,
      `injected error before ${step}`,
      `not-written at ${step}; previous intact; nothing left`,
      `${r.status}${r.status === "written" ? "" : ` at ${r.step}`}; previous ${intact ? "intact" : "CHANGED"}; ${left.length ? `left ${left.join(",")}` : "nothing left"}`,
    );
  }

  // --- Killed processes ---------------------------------------------------------------------
  const crashes: Record<string, unknown>[] = [];
  for (const step of [
    "mkdir",
    "lock",
    "read-previous",
    "write-temp",
    "fsync-temp",
    "verify-temp",
    "rename",
    "fsync-dir",
    "unlock",
  ] as WriteStep[]) {
    const root = fresh();
    await put(root, 2);
    const before = readFileSync(fileOf(root), "utf8");
    const done = await spawnWorker(["crash", root, JSON.stringify(ctx), step, "7"]).done;
    const names = readdirSync(join(fileOf(root), ".."));
    const loaded = await confirmed(root);
    crashes.push({
      step,
      exitCode: done.code,
      lockLeft: names.includes(LOCK_FILE),
      tempLeft: names.some((x) => x.endsWith(".tmp")),
      read: describe(loaded),
      previousBytesIntact: readFileSync(fileOf(root), "utf8") === before,
    });
    // The scenario counts only if the worker really died at the injected point (exit 70).
    const replaced = step === "fsync-dir" || step === "unlock";
    row(
      `K-${step}`,
      `process killed before ${step}`,
      `exit 70; read hit:${replaced ? 7 : 2}`,
      `exit ${String(done.code)}; read ${describe(loaded)}`,
    );
  }

  // --- Locks ----------------------------------------------------------------------------------
  const locks: Record<string, unknown> = {};
  {
    const root = fresh();
    await put(root, 2);
    const crashed = await spawnWorker(["crash", root, JSON.stringify(ctx), "read-previous"]).done;
    const t = performance.now();
    const r = await put(root, 5);
    locks.crashedHolder = {
      holderExit: crashed.code,
      writeResult: r.status === "written" ? "written" : r.reason,
      waitedMs: Math.round(performance.now() - t),
      configuredDeadlineMs: LOCK_WAIT_MS,
      lockStillPresent: readdirSync(join(fileOf(root), "..")).includes(LOCK_FILE),
      readerResult: describe(await confirmed(root)),
    };
    row(
      "L1",
      "write while a crashed holder's lock remains",
      "holder exit 70; lock-timeout; lock kept",
      `holder exit ${String(crashed.code)}; ${String((locks.crashedHolder as { writeResult: string }).writeResult)}; lock ${(locks.crashedHolder as { lockStillPresent: boolean }).lockStillPresent ? "kept" : "REMOVED"}`,
    );
  }
  {
    const root = fresh();
    const lock = join(fileOf(root), "..", LOCK_FILE);
    mkdirSync(join(lock, ".."), { recursive: true });
    writeFileSync(lock, JSON.stringify({ token: "other" }));
    const day = (Date.now() - 86_400_000) / 1000;
    utimesSync(lock, day, day);
    const r = await put(root, 1);
    row(
      "L2",
      "lock file one day old (unknown holder)",
      "lock-timeout; lock kept",
      `${r.status === "written" ? "written" : r.reason}; lock ${readdirSync(join(lock, "..")).includes(LOCK_FILE) ? "kept" : "REMOVED"}`,
    );
  }
  {
    const root = fresh();
    const holder = spawnWorker(["hold", root, JSON.stringify(ctx), String(LOCK_WAIT_MS + 1500)]);
    await holder.waitFor("held");
    const t = performance.now();
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(2, iso(Date.now())), {
      lockNow: () => Date.now() + 20_000,
    });
    const waited = Math.round(performance.now() - t);
    const h = await holder.done;
    locks.liveHolderPastStaleAge = {
      contenderClockAheadMs: 20_000,
      waitedMs: waited,
      contender: r.status === "written" ? "written" : r.reason,
      holder: (h.result as { status?: string } | undefined)?.status,
    };
    row(
      "L3",
      "live holder whose lock looks 20 s old",
      "contender lock-timeout; holder exit 0, written",
      `contender ${r.status === "written" ? "written" : r.reason}; holder exit ${String(h.code)}, ${String((h.result as { status?: string } | undefined)?.status)}`,
    );
  }

  // --- Concurrency ------------------------------------------------------------------------
  const concurrency: Record<string, unknown>[] = [];
  for (const [writers, each] of [
    [2, 25],
    [4, 10],
  ] as const) {
    const root = fresh();
    const t = performance.now();
    // Readiness barrier: every writer reports ready, then all start on one go file.
    const go = join(root, "go");
    const workers = Array.from({ length: writers }, (_, i) =>
      spawnWorker([
        "write",
        root,
        JSON.stringify(ctx),
        `w${i}`,
        String(each),
        String(i * 1000),
        go,
      ]),
    );
    await Promise.all(workers.map((w) => w.waitFor("ready")));
    writeFileSync(go, "");
    const results = await Promise.all(workers.map((w) => w.done));
    const wall = Math.round(performance.now() - t);
    const final = await confirmed(root);
    const tallies = results.map(
      (x) =>
        x.result as {
          written: number;
          notWritten: Record<string, number>;
          renameRetries: number;
          lockBusy: number;
          firstWriteAt: number;
          lastWriteAt: number;
        },
    );
    concurrency.push({
      writers,
      writesEach: each,
      wallMsIncludingStartup: wall,
      // Positive: every writer was still writing after the last one started.
      allWritersOverlapMs:
        Math.min(...tallies.map((x) => x.lastWriteAt)) -
        Math.max(...tallies.map((x) => x.firstWriteAt)),
      lockBusyTotal: tallies.reduce((a, x) => a + x.lockBusy, 0),
      exitCodes: results.map((x) => x.code),
      tallies,
      finalRecords: final.status === "miss" ? final.reason : final.snapshot.records.length,
    });
    row(
      `W${writers}`,
      `${writers} processes x ${each} read-modify-writes`,
      `${writers * each} records; every writer exit 0 with ${each} written, none failed; overlapped`,
      `${final.status === "miss" ? final.reason : final.snapshot.records.length} records; ${writersVerdict(
        each,
        results.map((x) => ({ code: x.code, result: x.result })),
      )}`,
    );
  }
  let readers: Record<string, unknown>;
  {
    const root = fresh();
    await put(root, 20);
    const writer = spawnWorker(["rewrite", root, JSON.stringify(ctx), "100"]);
    await writer.waitFor("started");
    let finished = false;
    const done = writer.done.then((d) => ((finished = true), d));
    const seen: Record<string, number> = {};
    while (!finished) {
      const k = describe(await confirmed(root));
      seen[k] = (seen[k] ?? 0) + 1;
    }
    const d = await done;
    readers = { writerExit: d.code, writer: d.result, reads: seen };
    row(
      "R1",
      "reads during 100 replacements",
      "writer exit 0, 100 written; no torn or failed reads",
      rewriteVerdict(100, d.code, d.result, seen),
    );
  }

  // --- Retention and cleanup --------------------------------------------------------------
  {
    const k = contextKey(ctx);
    if (!k.ok) throw new Error(k.reason);
    const t = Date.now();
    const big = applyObservation(undefined, k, syntheticObservation(300, iso(t)), t);
    row(
      "E1",
      "300 records offered",
      "256 kept, 44 evicted",
      `${big.snapshot.records.length} kept, ${big.omissions.evicted.length} evicted`,
    );
    {
      // The eviction must survive a write and a reload, not just appear in the write result.
      const capRoot = fresh();
      await put(capRoot, 300, ctx, t);
      const back = await confirmed(capRoot, ctx, t);
      row(
        "E5",
        "store 300, then reload",
        "hit:256, coverage incomplete, 44 evicted on reload",
        back.status === "miss"
          ? describe(back)
          : `${describe(back)}, coverage ${back.coverageComplete ? "complete" : "incomplete"}, ${back.storedOmissions.evicted.length} evicted on reload`,
      );
    }
    const prev = applyObservation(undefined, k, syntheticObservation(10, iso(t)), t).snapshot;
    const partial = applyObservation(prev, k, syntheticObservation(4, iso(t), "partial"), t);
    row(
      "E2",
      "partial manifest lists 4 of 10",
      "10 kept, 0 pruned",
      `${partial.snapshot.records.length} kept, ${partial.omissions.prunedUnseen.length} pruned`,
    );
    const complete = applyObservation(prev, k, syntheticObservation(4, iso(t)), t);
    row(
      "E3",
      "complete manifest lists 4 of 10",
      "4 kept, 6 pruned",
      `${complete.snapshot.records.length} kept, ${complete.omissions.prunedUnseen.length} pruned`,
    );
    const root = fresh();
    const old = { ...ctx, repository: "example/old" };
    const busy = { ...ctx, repository: "example/busy" };
    await put(root, 1, old, t - RETENTION_MS - 60_000);
    await put(root, 1, ctx, t);
    await put(root, 1, busy, t - RETENTION_MS - 60_000);
    writeFileSync(join(fileOf(root), "..", `${SNAPSHOT_FILE}.1.dead.tmp`), "{");
    writeFileSync(join(fileOf(root, busy), "..", LOCK_FILE), "held");
    const c = await cleanupExpired(root);
    row(
      "E4",
      "cleanup: expired, fresh+orphan temp, expired+locked",
      "removed 1, temps 1, busy 1",
      `removed ${c.removedContexts.length}, temps ${c.removedTemps.length}, busy ${c.busy.length}`,
    );
  }

  return { rows, sizes, crashes, locks, concurrency, readers };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: { iterations: { type: "string", default: "30" }, root: { type: "string" } },
  });
  const iterations = Number(values.iterations);
  if (!Number.isInteger(iterations) || iterations < 1)
    throw new Error("--iterations must be a positive integer");
  let base: string;
  if (values.root) {
    mkdirSync(values.root, { recursive: true });
    if (readdirSync(values.root).length) throw new Error("--root must be empty");
    base = values.root;
  } else base = mkdtempSync(join(tmpdir(), "storage-run-"));
  const started = Date.now();
  let result: Awaited<ReturnType<typeof runExperiment>> | undefined;
  let failure: string | undefined;
  try {
    result = await runExperiment(base, iterations);
  } catch (e) {
    failure = e instanceof Error ? e.message : String(e);
  }
  // Every worker is awaited inside runExperiment, so all holders have exited when it returns.
  // After a failure that may not hold, so the root is preserved for inspection.
  const cleanup = values.root
    ? "preserved (--root given)"
    : await removeExperimentRoot(base, { holdersJoined: failure === undefined });
  console.log(
    JSON.stringify(
      {
        schemaVersion: 1,
        kind: "cache-experiment",
        experiment: "storage",
        mode: "real filesystem, temporary root, synthetic records; no network",
        environment: {
          platform: process.platform,
          osRelease: release(),
          node: process.version,
          proposedRoot: proposedRoot().replace(homedir(), "~"),
          startedAt: new Date(started).toISOString(),
          elapsedMs: Date.now() - started,
          iterations,
        },
        limits: { maxRecords: MAX_RECORDS, retentionMs: RETENTION_MS, lockWaitMs: LOCK_WAIT_MS },
        ...(failure ? { failure } : {}),
        ...result,
        passed: result ? result.rows.filter((r) => r.pass).length : 0,
        failed: result ? result.rows.filter((r) => !r.pass).map((r) => r.id) : [],
        root: cleanup === "removed" ? "removed" : `${cleanup}: ${base}`,
      },
      null,
      2,
    ),
  );
  if (failure || result?.rows.some((r) => !r.pass)) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
