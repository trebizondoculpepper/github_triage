/**
 * Child process for the #203 storage experiment: real separate processes for concurrent writers,
 * a long-lived lock holder, a crash at a chosen write step and a writer racing readers. Started
 * by storage-run.ts and storage.test.ts through `spawnWorker`; prints one JSON line when done
 * (and "held" while holding a lock). Only touches the root it is given.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  LOCK_FILE,
  errorCode,
  realFs,
  storeSnapshot,
  syntheticObservation,
  syntheticRecord,
  type Context,
  type StorageFs,
  type WriteStep,
} from "./storage.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");

export interface Worker {
  child: ChildProcess;
  /** Resolves when the worker prints `line`; rejects if it exits first. */
  waitFor(line: string): Promise<void>;
  /** Resolves on exit with the exit code, the last JSON line on stdout and stderr. */
  done: Promise<{ code: number | null; result: unknown; stderr: string }>;
}

/** Start this worker in a new Node process (TypeScript through tsx, as the examples use). */
export function spawnWorker(args: string[]): Worker {
  const child = spawn(
    process.execPath,
    ["--import", "tsx", resolve(here, "storage-worker.ts"), ...args],
    { cwd: repoRoot, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  let err = "";
  const waiters: { line: string; ok: () => void; fail: (e: Error) => void }[] = [];
  const settle = () => {
    const lines = out.split(/\r?\n/);
    const ready = waiters.filter((w) => lines.includes(w.line));
    for (const w of ready) {
      waiters.splice(waiters.indexOf(w), 1);
      w.ok();
    }
  };
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString();
    settle();
  });
  child.stderr?.on("data", (c: Buffer) => (err += c.toString()));
  const done = new Promise<{ code: number | null; result: unknown; stderr: string }>((ok) =>
    child.once("close", (code) => {
      for (const w of waiters.splice(0))
        w.fail(new Error(`worker exited (${code}) before "${w.line}": ${err}`));
      const last = out
        .split(/\r?\n/)
        .filter((l) => l.startsWith("{"))
        .pop();
      ok({ code, result: last ? JSON.parse(last) : undefined, stderr: err });
    }),
  );
  return {
    child,
    done,
    waitFor: (line) =>
      new Promise((ok, fail) => {
        waiters.push({ line, ok, fail });
        settle();
      }),
  };
}

const ISO = (ms: number) => new Date(ms).toISOString();

async function main(argv: string[]): Promise<void> {
  const [mode, root, contextJson, ...rest] = argv;
  if (!mode || !root || !contextJson) throw new Error("usage: MODE ROOT CONTEXT_JSON ...");
  const context = JSON.parse(contextJson) as Context;
  const print = (v: unknown) => process.stdout.write(JSON.stringify(v) + "\n");

  if (mode === "write") {
    // Each write adds one record of this writer's own, keeping everything already stored.
    const [writer = "w", countText = "10", offsetText = "0", goFile = ""] = rest;
    const count = Number(countText);
    const offset = Number(offsetText);
    const tally = {
      writer,
      written: 0,
      notWritten: {} as Record<string, number>,
      renameRetries: 0,
      /** Lock attempts that found the lock already held (EEXIST): evidence of real overlap. */
      lockBusy: 0,
      firstWriteAt: 0,
      lastWriteAt: 0,
    };
    // Count lock contention without changing behaviour.
    const fs: StorageFs = {
      ...realFs,
      writeFile: async (path, data, options) => {
        try {
          return await realFs.writeFile(path, data, options);
        } catch (e) {
          if (errorCode(e) === "EEXIST" && path.endsWith(LOCK_FILE)) tally.lockBusy++;
          throw e;
        }
      },
    };
    // Optional readiness barrier: report ready, then wait for the parent's go file, so every
    // writer starts together however long process startup took.
    if (goFile) {
      process.stdout.write("ready\n");
      while (!existsSync(goFile)) await new Promise((ok) => setTimeout(ok, 2));
    }
    tally.firstWriteAt = Date.now();
    for (let i = 0; i < count; i++) {
      const at = ISO(Date.now());
      const r = await storeSnapshot(
        root,
        context,
        (prev) => {
          const kept = prev.status === "miss" ? [] : prev.snapshot.records;
          const mine = syntheticRecord(offset + i, at);
          return {
            observedAt: at,
            // Partial coverage: each writer sees only its own subject, so nothing is pruned.
            sourceCoverage: { issues: { status: "partial", pages: 1, scope: writer } },
            manifest: [...kept, mine].map((x) => ({
              subject: x.subject,
              state: "OPEN",
              updatedAt: at,
            })),
            records: [...kept.filter((x) => x.subject !== mine.subject), mine],
          };
        },
        { fs },
      );
      if (r.status === "written") {
        tally.written++;
        tally.renameRetries += r.renameRetries;
      } else tally.notWritten[r.reason] = (tally.notWritten[r.reason] ?? 0) + 1;
    }
    tally.lastWriteAt = Date.now();
    print(tally);
    return;
  }
  if (mode === "hold") {
    // Take the lock through a normal write, then hold it for `ms` before finishing the write.
    const ms = Number(rest[0] ?? "1000");
    const r = await storeSnapshot(root, context, () => syntheticObservation(1, ISO(Date.now())), {
      afterStep: async (step) => {
        if (step === "lock") {
          process.stdout.write("held\n");
          await new Promise((ok) => setTimeout(ok, ms));
        }
      },
    });
    print({ status: r.status });
    return;
  }
  if (mode === "crash") {
    // Exit abruptly (no finally blocks, no cleanup) just before `step`.
    const step = rest[0] as WriteStep;
    const records = Number(rest[1] ?? "3");
    await storeSnapshot(root, context, () => syntheticObservation(records, ISO(Date.now())), {
      beforeStep: (s) => {
        if (s === step) process.exit(70);
      },
    });
    print({ status: "completed without crashing" });
    return;
  }
  if (mode === "rewrite") {
    // Replace the snapshot repeatedly, alternating sizes so torn reads would be visible.
    const count = Number(rest[0] ?? "100");
    const tally = { written: 0, notWritten: {} as Record<string, number>, renameRetries: 0 };
    process.stdout.write("started\n");
    for (let i = 0; i < count; i++) {
      const r = await storeSnapshot(root, context, () =>
        syntheticObservation(i % 2 ? 200 : 20, ISO(Date.now())),
      );
      if (r.status === "written") {
        tally.written++;
        tally.renameRetries += r.renameRetries;
      } else tally.notWritten[r.reason] = (tally.notWritten[r.reason] ?? 0) + 1;
    }
    print(tally);
    return;
  }
  throw new Error(`unknown mode ${mode}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href)
  main(process.argv.slice(2)).catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`);
    process.exit(1);
  });
