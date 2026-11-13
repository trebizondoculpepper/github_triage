/**
 * Short-lived cross-process exclusive file lock with bounded waiting and stale-lock recovery.
 * Shared by the daily update cache (#65) and identity writes (#70).
 *
 * The lock file is created with the exclusive `wx` flag (portable, including Windows) and
 * holds a random token. A contender breaks a stale lock only if the token it judged stale is
 * still there immediately before unlinking, proceeds only if the lock it created still holds
 * its own token, and releases only a lock holding its token. The deadline is checked on every
 * iteration, and any unexpected filesystem error (for example a directory at the lock path)
 * gives up at once instead of retrying.
 *
 * Remaining race, accepted: between the final token re-read and the unlink of a stale lock,
 * another contender can break the same lock and create its own, which this unlink then removes.
 * Both may then believe they hold the lock. Each verifies its token after creating, and release
 * only removes its own token. Callers keep a second guard (atomic replacement, and for identity
 * writes an unchanged-since-read check) so the worst case is never a corrupt file.
 */
import { randomBytes } from "node:crypto";

/** The filesystem operations the lock needs; `node:fs/promises` satisfies it. */
export interface LockFs {
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { flag?: string }): Promise<void>;
  unlink(path: string): Promise<void>;
  stat(path: string): Promise<{ mtimeMs: number }>;
}

export interface LockTiming {
  /** How long to wait for another holder before giving up. */
  readonly waitMs: number;
  /** A lock older than this is from a crashed or stuck process and may be broken. */
  readonly staleMs: number;
  /** Delay between attempts. */
  readonly pollMs: number;
}

/**
 * Take the lock. Returns a release function, or null when the lock could not be taken safely
 * within `waitMs`.
 */
export async function acquireFileLock(
  fs: LockFs,
  lock: string,
  timing: LockTiming,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<(() => Promise<void>) | null> {
  const token = randomBytes(16).toString("hex");
  const deadline = now() + timing.waitMs;
  const holder = async (): Promise<string | undefined> => {
    const text = await fs.readFile(lock, "utf8"); // filesystem errors propagate
    try {
      const parsed: unknown = JSON.parse(text);
      return isRecord(parsed) && typeof parsed.token === "string" ? parsed.token : text;
    } catch {
      return text; // a torn or foreign lock is identified by its content
    }
  };
  const release = async () => {
    try {
      if ((await holder()) === token) await fs.unlink(lock);
    } catch {
      // Already gone or replaced: nothing of ours to remove.
    }
  };
  for (;;) {
    try {
      await fs.writeFile(lock, JSON.stringify({ token, pid: process.pid, at: now() }), {
        flag: "wx",
      });
      // Proceed only if the lock still holds our token (see the race note above).
      try {
        return (await holder()) === token ? release : null;
      } catch {
        return null;
      }
    } catch (error) {
      if (code(error) !== "EEXIST") return null;
    }
    try {
      if (now() - (await fs.stat(lock)).mtimeMs > timing.staleMs) {
        const stale = await holder();
        // Confirm staleness, then re-read immediately before unlinking: another contender may
        // have broken it and taken the lock already, and that fresh lock must survive.
        if (now() - (await fs.stat(lock)).mtimeMs > timing.staleMs && (await holder()) === stale)
          await fs.unlink(lock);
      } else if (now() < deadline) {
        await sleep(timing.pollMs);
      }
    } catch (error) {
      // Released between our attempt and the stat: try again. Anything else: give up.
      if (code(error) !== "ENOENT") return null;
    }
    if (now() >= deadline) return null;
  }
}

const code = (error: unknown) => (isRecord(error) ? error.code : undefined);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
