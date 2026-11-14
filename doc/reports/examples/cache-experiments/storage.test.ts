import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { copyFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vite-plus/test";
import { acquireFileLock } from "../../../../src/config/filelock.js";
import {
  LOCK_FILE,
  MAX_RECORDS,
  RETENTION_MS,
  SNAPSHOT_FILE,
  applyObservation,
  cleanupExpired,
  contextDir,
  contextKey,
  loadSnapshot,
  realFs,
  removeExperimentRoot,
  storeSnapshot,
  syntheticObservation,
  type Context,
  type CoverageStatus,
  type StorageFs,
  type WriteStep,
} from "./storage.js";
import { rewriteVerdict, writersVerdict } from "./storage-run.js";
import { spawnWorker } from "./storage-worker.js";

const roots: string[] = [];
const newRoot = () => {
  const r = mkdtempSync(join(tmpdir(), "storage-exp-"));
  roots.push(r);
  return r;
};
// Every worker below is joined before its test ends, so the roots can be removed.
afterAll(() => {
  for (const r of roots) {
    try {
      chmodSync(r, 0o700);
    } catch {
      // ignore
    }
    rmSync(r, { recursive: true, force: true });
  }
});

const ctx: Context = {
  host: "github.com",
  repository: "example/repo",
  authenticatedLogin: "agent",
  collectionProfile: "default",
};
const T0 = Date.parse("2026-11-14T12:00:00Z");
const at = (ms = T0) => new Date(ms).toISOString();
const key = () => {
  const k = contextKey(ctx);
  if (!k.ok) throw new Error(k.reason);
  return k;
};
const file = (root: string, c: Context = ctx) => {
  const k = contextKey(c);
  if (!k.ok) throw new Error(k.reason);
  return join(contextDir(root, k.key), SNAPSHOT_FILE);
};
const read = (root: string, c: Context = ctx, now = T0) =>
  loadSnapshot(root, c, { now: () => now, access: "confirmed" });
const write = (
  root: string,
  n: number,
  c: Context = ctx,
  now = T0,
  coverage: CoverageStatus = "complete",
) => storeSnapshot(root, c, () => syntheticObservation(n, at(now), coverage), { now: () => now });
const posix = process.platform !== "win32";
const root0 = typeof process.getuid === "function" && process.getuid() === 0;

describe("context isolation", () => {
  it("canonicalises case but separates every dimension", () => {
    const base = key().key;
    const same = contextKey({
      ...ctx,
      host: "GitHub.com.",
      repository: "Example/Repo",
      authenticatedLogin: "Agent",
    });
    expect(same.ok && same.key).toBe(base);
    for (const change of [
      { host: "ghe.example.com" },
      { repository: "example/other" },
      { authenticatedLogin: "someone" },
      { collectionProfile: "rich" },
    ]) {
      const other = contextKey({ ...ctx, ...change });
      expect(other.ok && other.key).not.toBe(base);
    }
    expect(contextKey({ ...ctx, authenticatedLogin: undefined }).ok).toBe(false);
    expect(contextKey({ ...ctx, repository: "../escape" }).ok).toBe(false);
  });

  it("never serves one context's snapshot to another", async () => {
    const root = newRoot();
    expect((await write(root, 3)).status).toBe("written");
    for (const change of [
      { host: "ghe.example.com" },
      { repository: "example/other" },
      { authenticatedLogin: "someone" },
      { collectionProfile: "rich" },
    ])
      expect(await read(root, { ...ctx, ...change })).toMatchObject({
        status: "miss",
        reason: "no-cache",
      });
    // A file copied into another context's directory is detected by its envelope.
    const other = { ...ctx, authenticatedLogin: "someone" };
    mkdirSync(join(file(root, other), ".."), { recursive: true });
    copyFileSync(file(root), file(root, other));
    expect(await read(root, other)).toMatchObject({ status: "miss", reason: "context-mismatch" });
  });

  it("unknown login: no read, no write", async () => {
    const root = newRoot();
    const unknown = { ...ctx, authenticatedLogin: undefined };
    expect(await read(root, unknown)).toMatchObject({ status: "miss", reason: "unknown-context" });
    expect(await write(root, 1, unknown)).toMatchObject({
      status: "not-written",
      reason: "unknown-context",
    });
    expect(existsSync(join(root, "v1"))).toBe(false);
  });

  it("does not reuse stored facts unless current access was confirmed", async () => {
    const root = newRoot();
    await write(root, 2);
    for (const access of ["lost", "unknown"] as const)
      expect(await loadSnapshot(root, ctx, { now: () => T0, access })).toMatchObject({
        status: "miss",
        reason: "access-not-confirmed",
      });
  });
});

describe("no cache, empty and corrupt are distinct", () => {
  it("classifies missing, empty (complete and partial) and populated snapshots", async () => {
    const root = newRoot();
    expect(await read(root)).toMatchObject({ status: "miss", reason: "no-cache" });
    await write(root, 0);
    expect(await read(root)).toMatchObject({ status: "empty", coverageComplete: true });
    const partial = newRoot();
    await write(partial, 0, ctx, T0, "partial");
    expect(await read(partial)).toMatchObject({ status: "empty", coverageComplete: false });
    await write(root, 4);
    expect(await read(root)).toMatchObject({
      status: "hit",
      freshness: "stored-unvalidated",
      coverageComplete: true,
    });
  });

  it("classifies damaged and foreign files as misses, never as empty", async () => {
    const root = newRoot();
    await write(root, 5);
    const good = readFileSync(file(root), "utf8");
    const parsed = JSON.parse(good) as Record<string, unknown>;
    const cases: [string, string][] = [
      ["", "truncated"],
      [good.slice(0, Math.floor(good.length / 2)), "truncated"],
      [good.slice(0, 1), "truncated"],
      [good.replace('"records":', '"records":x'), "corrupt"],
      ["\u0000".repeat(64), "corrupt"],
      [JSON.stringify({ ...parsed, records: "nope" }), "corrupt"],
      [JSON.stringify([1, 2]), "corrupt"],
      [JSON.stringify({ ...parsed, schemaVersion: 2 }), "future-schema"],
      [JSON.stringify({ ...parsed, schemaVersion: 0 }), "schema-mismatch"],
      [JSON.stringify({ ...parsed, kind: "something-else" }), "schema-mismatch"],
      [JSON.stringify({ ...parsed, observedAt: at(T0 + 3_600_000) }), "future-timestamp"],
    ];
    for (const [text, reason] of cases) {
      writeFileSync(file(root), text);
      expect(await read(root), JSON.stringify(text.slice(0, 40))).toMatchObject({
        status: "miss",
        reason,
      });
    }
    writeFileSync(file(root), good);
    expect(await read(root, ctx, T0 + RETENTION_MS + 1)).toMatchObject({
      status: "miss",
      reason: "expired",
    });
    // Clock rollback: the stored write is now in the future of the local clock.
    expect(await read(root, ctx, T0 - 2 * 3_600_000)).toMatchObject({
      status: "miss",
      reason: "future-timestamp",
    });
  });

  it("a damaged file is replaced by the next successful write", async () => {
    const root = newRoot();
    await write(root, 2);
    writeFileSync(file(root), "{");
    const result = await write(root, 3);
    expect(result).toMatchObject({ status: "written", previous: "truncated" });
    expect(await read(root)).toMatchObject({ status: "hit" });
  });
});

describe("atomic replace and injected failures", () => {
  const steps: WriteStep[] = [
    "mkdir",
    "lock",
    "read-previous",
    "write-temp",
    "fsync-temp",
    "verify-temp",
    "rename",
  ];
  for (const step of steps)
    it(`a failure before ${step} keeps the previous snapshot and releases the lock`, async () => {
      const root = newRoot();
      await write(root, 2);
      const before = readFileSync(file(root), "utf8");
      const result = await storeSnapshot(root, ctx, () => syntheticObservation(9, at(T0 + 1000)), {
        now: () => T0 + 1000,
        beforeStep: (s) => {
          if (s === step) throw Object.assign(new Error("injected"), { code: "EIO" });
        },
      });
      expect(result).toMatchObject({ status: "not-written", reason: "failed", step });
      expect(readFileSync(file(root), "utf8")).toBe(before);
      const left = readdirSync(join(file(root), ".."));
      expect(left).toEqual([SNAPSHOT_FILE]); // no temp file, no lock
      // lastSuccessfulAt did not move.
      const loaded = await read(root, ctx, T0 + 1000);
      expect(loaded.status === "hit" && loaded.snapshot.lastSuccessfulAt).toBe(at(T0));
    });

  it("a hook failure right after taking the lock releases it", async () => {
    const root = newRoot();
    await write(root, 2);
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(3, at()), {
      now: () => T0,
      afterStep: (s) => {
        if (s === "lock") throw new Error("injected");
      },
    });
    expect(r).toMatchObject({ status: "not-written", reason: "failed", step: "lock" });
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
    expect((await write(root, 4)).status).toBe("written");
  });

  it("hook failures around unlock still release the lock", async () => {
    const root = newRoot();
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(3, at()), {
      now: () => T0,
      beforeStep: (s) => {
        if (s === "unlock") throw new Error("injected");
      },
      afterStep: (s) => {
        if (s === "unlock") throw new Error("injected");
      },
    });
    expect(r.status).toBe("written");
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
  });

  it("a failure after the temp write removes the temp file", async () => {
    const root = newRoot();
    await write(root, 2);
    const result = await storeSnapshot(root, ctx, () => syntheticObservation(3, at()), {
      now: () => T0,
      afterStep: (s) => {
        if (s === "write-temp") throw new Error("injected");
      },
    });
    expect(result).toMatchObject({ status: "not-written", step: "write-temp" });
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
  });

  it("retries a rename refused like a Windows sharing violation, then gives up", async () => {
    const flaky = (failures: number): StorageFs => {
      let left = failures;
      return {
        ...realFs,
        rename: async (a, b) => {
          if (left-- > 0) throw Object.assign(new Error("busy"), { code: "EPERM" });
          return realFs.rename(a, b);
        },
      };
    };
    const root = newRoot();
    await write(root, 1);
    const ok = await storeSnapshot(root, ctx, () => syntheticObservation(2, at()), {
      fs: flaky(2),
      now: () => T0,
    });
    expect(ok).toMatchObject({ status: "written", renameRetries: 2 });
    const before = readFileSync(file(root), "utf8");
    const bad = await storeSnapshot(root, ctx, () => syntheticObservation(7, at()), {
      fs: flaky(99),
      now: () => T0,
    });
    expect(bad).toMatchObject({ status: "not-written", step: "rename" });
    expect(readFileSync(file(root), "utf8")).toBe(before);
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
  });

  it("an unreadable snapshot is a classified miss", async () => {
    const root = newRoot();
    await write(root, 1);
    const denied: StorageFs = {
      ...realFs,
      readFile: async () => {
        throw Object.assign(new Error("denied"), { code: "EACCES" });
      },
    };
    expect(
      await loadSnapshot(root, ctx, { fs: denied, now: () => T0, access: "confirmed" }),
    ).toMatchObject({ status: "miss", reason: "unreadable" });
  });

  it.skipIf(!posix || root0)("inaccessible directory: miss on read, failure on write", async () => {
    const root = newRoot();
    await write(root, 2);
    const dir = join(file(root), "..");
    const before = readFileSync(file(root), "utf8");
    chmodSync(dir, 0o000);
    try {
      expect(await read(root)).toMatchObject({ status: "miss", reason: "unreadable" });
      const r = await write(root, 5);
      expect(r.status).toBe("not-written");
    } finally {
      chmodSync(dir, 0o700);
    }
    expect(readFileSync(file(root), "utf8")).toBe(before);
  });

  it.skipIf(!posix)("creates the context directory 0700 and the snapshot 0600", async () => {
    const root = newRoot();
    await write(root, 1);
    const st = await nodeFs.stat(join(file(root), ".."));
    expect(st.mode & 0o777).toBe(0o700);
    expect((await nodeFs.stat(file(root))).mode & 0o777).toBe(0o600);
  });
});

describe("locking", () => {
  /** A virtual clock: sleeping advances it, so a 5 s deadline runs instantly. */
  const virtual = (startMs: number) => {
    let t = startMs;
    return { now: () => t, sleep: async (ms: number) => void (t += ms) };
  };

  it("never breaks an old lock by age; times out after five seconds instead", async () => {
    const root = newRoot();
    await write(root, 1);
    const lock = join(file(root), "..", LOCK_FILE);
    writeFileSync(lock, JSON.stringify({ token: "other", pid: 1, at: 0 }));
    const day = (Date.now() - 86_400_000) / 1000;
    utimesSync(lock, day, day);
    const clock = virtual(Date.now());
    const started = clock.now();
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(2, at()), {
      now: () => T0,
      lockNow: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toMatchObject({ status: "not-written", reason: "lock-timeout" });
    expect(clock.now() - started).toBeGreaterThanOrEqual(5000);
    expect(clock.now() - started).toBeLessThan(5100);
    expect(JSON.parse(readFileSync(lock, "utf8"))).toMatchObject({ token: "other" });
    // Contrast: the helper's age-based path (as the update cache uses it) would take it over.
    const broken = await acquireFileLock(
      nodeFs,
      lock,
      { waitMs: 1000, staleMs: 10_000, pollMs: 25 },
      Date.now,
      async () => {},
    );
    expect(broken).not.toBeNull();
    await broken?.();
  });

  it("a live holder past the helper's 10 s stale age keeps its lock", async () => {
    const root = newRoot();
    const holder = spawnWorker(["hold", root, JSON.stringify(ctx), "2500"]);
    await holder.waitFor("held");
    // The contender's clock runs 20 s ahead, so the holder's lock looks 20 s old.
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(2, at()), {
      lockNow: () => Date.now() + 20_000,
      lockWaitMs: 1000,
    });
    expect(r).toMatchObject({ status: "not-written", reason: "lock-timeout" });
    const done = await holder.done;
    expect(done.result).toEqual({ status: "written" });
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
  }, 30_000);

  it("a crashed holder's lock causes a bounded miss, not a takeover; cleanup needs confirmation", async () => {
    const root = newRoot();
    await write(root, 2);
    const before = readFileSync(file(root), "utf8");
    const crashed = spawnWorker(["crash", root, JSON.stringify(ctx), "read-previous"]);
    expect((await crashed.done).code).toBe(70);
    const lock = join(file(root), "..", LOCK_FILE);
    expect(existsSync(lock)).toBe(true);
    // Readers are unaffected: the previous snapshot is still served.
    expect(await read(root)).toMatchObject({ status: "hit" });
    const clock = virtual(Date.now());
    const r = await storeSnapshot(root, ctx, () => syntheticObservation(5, at()), {
      now: () => T0,
      lockNow: clock.now,
      sleep: clock.sleep,
    });
    expect(r).toMatchObject({ status: "not-written", reason: "lock-timeout" });
    expect(existsSync(lock)).toBe(true);
    expect(readFileSync(file(root), "utf8")).toBe(before);
    expect(await removeExperimentRoot(root, { holdersJoined: false })).toBe("preserved");
    expect(existsSync(lock)).toBe(true);
    // The crashed worker has exited and been joined above, so the runner may now clean up.
    expect(await removeExperimentRoot(root, { holdersJoined: true })).toBe("removed");
    expect(existsSync(root)).toBe(false);
  }, 30_000);
});

describe("separate processes", () => {
  it("two concurrent writers lose no records", async () => {
    const root = newRoot();
    // Readiness barrier: both report ready, then start together on the go file.
    const go = join(root, "go");
    const a = spawnWorker(["write", root, JSON.stringify(ctx), "a", "15", "0", go]);
    const b = spawnWorker(["write", root, JSON.stringify(ctx), "b", "15", "1000", go]);
    await Promise.all([a.waitFor("ready"), b.waitFor("ready")]);
    writeFileSync(go, "");
    const [ra, rb] = await Promise.all([a.done, b.done]);
    expect(ra.code, ra.stderr).toBe(0);
    expect(rb.code, rb.stderr).toBe(0);
    expect(ra.result).toMatchObject({ written: 15, notWritten: {} });
    expect(rb.result).toMatchObject({ written: 15, notWritten: {} });
    const loaded = await loadSnapshot(root, ctx, { access: "confirmed" });
    expect(loaded.status).toBe("hit");
    if (loaded.status === "hit") expect(loaded.snapshot.records).toHaveLength(30);
    // The pass needs evidence of real overlap, not just correct totals.
    expect(writersVerdict(15, [ra, rb]), JSON.stringify([ra.result, rb.result])).toBe(
      "every writer exit 0 with 15 written, none failed; overlapped",
    );
    expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
  }, 60_000);

  it("readers during repeated renames never see a torn file", async () => {
    const root = newRoot();
    await write(root, 20, ctx, Date.now());
    const writer = spawnWorker(["rewrite", root, JSON.stringify(ctx), "60"]);
    await writer.waitFor("started");
    let finished = false;
    const done = writer.done.then((d) => ((finished = true), d));
    const seen: Record<string, number> = {};
    while (!finished) {
      const r = await loadSnapshot(root, ctx, { access: "confirmed" });
      const k = r.status === "miss" ? r.reason : `${r.status}:${r.snapshot.records.length}`;
      seen[k] = (seen[k] ?? 0) + 1;
    }
    const d = await done;
    expect(d.code, d.stderr).toBe(0);
    expect(d.result).toMatchObject({ written: 60, notWritten: {} });
    const reads = Object.values(seen).reduce((x, y) => x + y, 0);
    expect(reads).toBeGreaterThan(0);
    expect(
      Object.keys(seen).every((k) => k === "hit:20" || k === "hit:200"),
      JSON.stringify(seen),
    ).toBe(true);
  }, 60_000);

  const crashCases: [WriteStep, { lock: boolean; temp: boolean; replaced: boolean }][] = [
    ["mkdir", { lock: false, temp: false, replaced: false }],
    ["lock", { lock: false, temp: false, replaced: false }],
    ["read-previous", { lock: true, temp: false, replaced: false }],
    ["write-temp", { lock: true, temp: false, replaced: false }],
    ["fsync-temp", { lock: true, temp: true, replaced: false }],
    ["verify-temp", { lock: true, temp: true, replaced: false }],
    ["rename", { lock: true, temp: true, replaced: false }],
    ["fsync-dir", { lock: true, temp: false, replaced: true }],
    ["unlock", { lock: true, temp: false, replaced: true }],
  ];
  it("a process killed at each write step leaves a readable snapshot", async () => {
    for (const [step, expected] of crashCases) {
      const root = newRoot();
      await write(root, 2, ctx, Date.now());
      const before = readFileSync(file(root), "utf8");
      const w = spawnWorker(["crash", root, JSON.stringify(ctx), step, "7"]);
      const d = await w.done;
      expect(d.code, `${step}: ${d.stderr}`).toBe(70);
      const names = readdirSync(join(file(root), ".."));
      expect(names.includes(LOCK_FILE), step).toBe(expected.lock);
      expect(
        names.some((n) => n.endsWith(".tmp")),
        step,
      ).toBe(expected.temp);
      const loaded = await loadSnapshot(root, ctx, { access: "confirmed" });
      expect(loaded.status, step).toBe("hit");
      if (loaded.status === "hit")
        expect(loaded.snapshot.records.length, step).toBe(expected.replaced ? 7 : 2);
      if (!expected.replaced) expect(readFileSync(file(root), "utf8"), step).toBe(before);
    }
  }, 120_000);
});

describe("retention, eviction and cleanup", () => {
  it("caps records at 256 and reports evictions", () => {
    const { snapshot, omissions } = applyObservation(
      undefined,
      key(),
      syntheticObservation(300, at()),
      T0,
    );
    expect(snapshot.records).toHaveLength(MAX_RECORDS);
    expect(omissions.evicted).toHaveLength(300 - MAX_RECORDS);
  });

  it("prunes unseen records only after a complete manifest", () => {
    const prev = applyObservation(undefined, key(), syntheticObservation(10, at()), T0).snapshot;
    const partial = applyObservation(prev, key(), syntheticObservation(4, at(), "partial"), T0);
    expect(partial.snapshot.records).toHaveLength(10);
    expect(partial.omissions.prunedUnseen).toEqual([]);
    const complete = applyObservation(prev, key(), syntheticObservation(4, at()), T0);
    expect(complete.snapshot.records).toHaveLength(4);
    expect(complete.omissions.prunedUnseen).toHaveLength(6);
  });

  it("drops records not seen for 24 hours and reports them", () => {
    const prev = applyObservation(undefined, key(), syntheticObservation(5, at()), T0).snapshot;
    const later = T0 + RETENTION_MS + 1;
    const next = applyObservation(
      prev,
      key(),
      syntheticObservation(2, at(later), "partial", 100),
      later,
    );
    expect(next.omissions.expired).toHaveLength(5);
    expect(next.snapshot.records).toHaveLength(2);
  });

  it("removes expired contexts and orphan temps, skips busy ones, and is bounded", async () => {
    const root = newRoot();
    const now = Date.now();
    const old = { ...ctx, repository: "example/old" };
    const busy = { ...ctx, repository: "example/busy" };
    await write(root, 1, old, now - RETENTION_MS - 60_000);
    await write(root, 1, ctx, now);
    await write(root, 1, busy, now - RETENTION_MS - 60_000);
    writeFileSync(join(file(root, ctx), "..", `${SNAPSHOT_FILE}.999.dead.tmp`), "{");
    writeFileSync(join(file(root, busy), "..", LOCK_FILE), "held elsewhere");
    const report = await cleanupExpired(root, { now: () => now });
    expect(report.examined).toBe(3);
    expect(report.removedContexts).toHaveLength(1);
    expect(existsSync(join(file(root, old), ".."))).toBe(false);
    expect(report.removedTemps).toHaveLength(1);
    expect(report.busy).toHaveLength(1);
    expect(existsSync(file(root, busy))).toBe(true);
    expect(await read(root, ctx, now)).toMatchObject({ status: "hit" });
    const bounded = await cleanupExpired(root, { now: () => now, limit: 1 });
    expect(bounded.examined).toBe(1);
    expect(bounded.deferred).toBe(1);
  });
});

describe("runner verdicts need completed workers", () => {
  const ok = { written: 100, notWritten: {} };
  const pass = "writer exit 0, 100 written; no torn or failed reads";
  it("R1 passes only when the rewrite worker finished every replacement", () => {
    const seen = { "hit:20": 5, "hit:200": 3 };
    expect(rewriteVerdict(100, 0, ok, seen)).toBe(pass);
    expect(rewriteVerdict(100, 1, undefined, seen)).not.toBe(pass);
    expect(
      rewriteVerdict(100, 0, { written: 40, notWritten: { "lock-timeout": 60 } }, seen),
    ).not.toBe(pass);
    expect(rewriteVerdict(100, 0, ok, {})).not.toBe(pass);
    expect(rewriteVerdict(100, 0, ok, { ...seen, truncated: 1 })).not.toBe(pass);
  });

  it("W passes only when every writer exited 0 with all writes done", () => {
    const pass10 = "every writer exit 0 with 10 written, none failed; overlapped";
    const good = {
      code: 0,
      result: { written: 10, notWritten: {}, lockBusy: 2, firstWriteAt: 100, lastWriteAt: 200 },
    };
    expect(writersVerdict(10, [good, good])).toBe(pass10);
    expect(writersVerdict(10, [good, { code: 1, result: undefined }])).not.toBe(pass10);
    expect(
      writersVerdict(10, [good, { code: 0, result: { written: 9, notWritten: { failed: 1 } } }]),
    ).not.toBe(pass10);
    expect(writersVerdict(10, [])).not.toBe(pass10);
    // Sequential: complete and correct, but no evidence the writers ran at the same time.
    const first = {
      code: 0,
      result: { ...good.result, lockBusy: 0, firstWriteAt: 0, lastWriteAt: 50 },
    };
    const second = {
      code: 0,
      result: { ...good.result, lockBusy: 0, firstWriteAt: 60, lastWriteAt: 90 },
    };
    expect(writersVerdict(10, [first, second])).toMatch(/^inconclusive/);
    // Overlapping in time but the lock was never contended: still inconclusive.
    const noBusy = { code: 0, result: { ...good.result, lockBusy: 0 } };
    expect(writersVerdict(10, [noBusy, noBusy])).toMatch(/^inconclusive/);
  });
});

describe("review fixes", () => {
  const H = 3_600_000;
  const obsOf = (
    subjects: number[],
    atMs: number,
    coverage: CoverageStatus,
    withRecords = true,
  ) => {
    const full = syntheticObservation(Math.max(...subjects), at(atMs), coverage);
    const keep = new Set(subjects.map((n) => full.records[n - 1]!.subject));
    return {
      ...full,
      manifest: full.manifest.filter((m) => keep.has(m.subject)),
      records: withRecords ? full.records.filter((r) => keep.has(r.subject)) : [],
    };
  };

  it("withholds records past 24 h on load even when lastSuccessfulAt is recent", async () => {
    const root = newRoot();
    await storeSnapshot(root, ctx, () => obsOf([1], T0, "partial"), { now: () => T0 });
    await storeSnapshot(root, ctx, () => obsOf([2], T0 + 23 * H, "partial"), {
      now: () => T0 + 23 * H,
    });
    const r = await read(root, ctx, T0 + 25 * H);
    expect(r.status).toBe("hit");
    if (r.status !== "hit") return;
    expect(r.snapshot.records.map((x) => x.subject)).toEqual(["issue:2"]);
    expect(r.expiredOnLoad).toEqual(["issue:1"]);
    expect(r.coverageComplete).toBe(false);
    // An all-expired snapshot with complete coverage is not an authoritative empty.
    const done = newRoot();
    await write(done, 2, ctx, T0);
    const late = await loadSnapshot(done, ctx, {
      now: () => T0 + 23 * H,
      access: "confirmed",
    });
    expect(late.status).toBe("hit");
    writeFileSync(
      file(done),
      readFileSync(file(done), "utf8").replace(
        /"lastSuccessfulAt":"[^"]+"/,
        `"lastSuccessfulAt":"${at(T0 + 20 * H)}"`,
      ),
    );
    const empty = await read(done, ctx, T0 + 25 * H);
    expect(empty).toMatchObject({ status: "empty", coverageComplete: false });
  });

  it("renews lastSeenAt when a manifest lists a kept record without new facts", async () => {
    const root = newRoot();
    await storeSnapshot(root, ctx, () => obsOf([1, 2], T0, "partial"), { now: () => T0 });
    await storeSnapshot(root, ctx, () => obsOf([1, 2], T0 + 23 * H, "partial", false), {
      now: () => T0 + 23 * H,
    });
    const r = await read(root, ctx, T0 + 25 * H);
    expect(r.status).toBe("hit");
    if (r.status !== "hit") return;
    expect(r.snapshot.records).toHaveLength(2);
    for (const rec of r.snapshot.records) {
      expect(rec.lastSeenAt).toBe(at(T0 + 23 * H));
      expect(rec.revalidatedAt).toBe(at(T0)); // facts are not claimed as revalidated
    }
  });

  it("rejects coverage and manifest entries missing required fields, without throwing", async () => {
    const root = newRoot();
    await write(root, 0);
    const good = JSON.parse(readFileSync(file(root), "utf8")) as Record<string, unknown>;
    const cov = (c: unknown) => JSON.stringify({ ...good, sourceCoverage: { issues: c } });
    const cases: [string, string][] = [
      [cov({ status: "complete" }), "corrupt"],
      [cov({ status: "complete", pages: 1 }), "corrupt"],
      [cov({ status: "complete", scope: "all" }), "corrupt"],
      [cov({ status: "complete", pages: -1, scope: "all" }), "corrupt"],
      [cov({ status: { toString: null }, pages: 1, scope: "all" }), "corrupt"],
      [JSON.stringify({ ...good, manifest: [{ subject: "issue:1", updatedAt: at() }] }), "corrupt"],
      [
        JSON.stringify({
          ...good,
          manifest: [{ subject: "issue:1", state: "OPEN", updatedAt: at(), headOid: 7 }],
        }),
        "corrupt",
      ],
      [JSON.stringify({ ...good, schemaVersion: { toString: null } }), "schema-mismatch"],
      [JSON.stringify({ ...good, lastSuccessfulAt: { toString: null } }), "corrupt"],
    ];
    for (const [text, reason] of cases) {
      writeFileSync(file(root), text);
      expect(await read(root), text.slice(0, 80)).toMatchObject({ status: "miss", reason });
    }
  });

  for (const [hook, step] of [
    ["afterStep", "rename"],
    ["beforeStep", "fsync-dir"],
  ] as const)
    it(`a failure at ${hook}(${step}) reports the committed replacement`, async () => {
      const root = newRoot();
      await write(root, 2);
      const fail = (s: WriteStep) => {
        if (s === step) throw new Error("injected");
      };
      const r = await storeSnapshot(root, ctx, () => syntheticObservation(5, at()), {
        now: () => T0,
        [hook]: fail,
      });
      expect(r).toMatchObject({ status: "committed-with-error", step });
      expect(await read(root)).toMatchObject({ status: "hit" });
      const loaded = await read(root);
      expect(loaded.status === "hit" && loaded.snapshot.records.length).toBe(5);
      expect(readdirSync(join(file(root), ".."))).toEqual([SNAPSHOT_FILE]);
    });

  it("bounded cleanup rotates past contexts that stay present", async () => {
    const root = newRoot();
    const now = Date.now();
    // Find two contexts whose keys sort fresh-first, then expired.
    const a = { ...ctx, repository: "example/a" };
    const b = { ...ctx, repository: "example/b" };
    const ka = contextKey(a);
    const kb = contextKey(b);
    if (!ka.ok || !kb.ok) throw new Error("keys");
    const [fresh, old] = ka.key < kb.key ? [a, b] : [b, a];
    await write(root, 1, fresh, now);
    await write(root, 1, old, now - RETENTION_MS - 60_000);
    const first = await cleanupExpired(root, { now: () => now, limit: 1 });
    expect(first).toMatchObject({ examined: 1, removedContexts: [], deferred: 1 });
    const second = await cleanupExpired(root, { now: () => now, limit: 1 });
    expect(second.removedContexts).toHaveLength(1);
    expect(existsSync(join(file(root, old), ".."))).toBe(false);
    expect(existsSync(file(root, fresh))).toBe(true);
    // Wraps around after the end.
    const third = await cleanupExpired(root, { now: () => now, limit: 1 });
    expect(third).toMatchObject({ examined: 1, kept: 1 });
  });
});
