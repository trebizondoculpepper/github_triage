import { describe, expect, it } from "vite-plus/test";
import {
  advanceManifest,
  applyConditional,
  classifyGh,
  diffManifest,
  manifestOf,
  baselineWorld,
  runScenarios,
  RECONCILE_MINUTES,
  warmRefresh,
  type ManifestEntry,
} from "./refresh.js";

const entry = (key: string, updatedAt: number): ManifestEntry => ({
  key,
  state: "OPEN",
  updatedAt,
});

describe("conditional refresh experiment (#202)", () => {
  for (const outcome of runScenarios())
    it(`${outcome.id} ${outcome.name}`, () => {
      expect(outcome.failures).toEqual([]);
    });

  it("treats absence from a partial manifest as unknown, not deletion", () => {
    const prev = manifestOf(baselineWorld());
    const next = { ...prev, coverage: "partial" as const, entries: prev.entries.slice(0, 10) };
    const diff = diffManifest(prev, next);
    expect(diff.removed).toEqual([]);
    expect(diff.absentUnknown.length).toBe(prev.entries.length - 10);
  });

  it("does not advance the manifest on a failed, cancelled or truncated read", () => {
    const prev = advanceManifest(
      undefined,
      [{ ok: true, entries: [entry("a", 1)], hasNextPage: false }],
      1,
    );
    expect(prev.advanced).toBe(true);
    const failed = advanceManifest(
      prev.manifest,
      [
        { ok: true, entries: [entry("a", 2)], hasNextPage: true },
        { ok: false, entries: [], hasNextPage: false },
      ],
      2,
    );
    expect(failed).toMatchObject({ advanced: false, manifest: prev.manifest });
    const truncated = advanceManifest(
      prev.manifest,
      [{ ok: true, entries: [], hasNextPage: true }],
      2,
    );
    expect(truncated).toMatchObject({ advanced: false, diagnostic: "pagination incomplete" });
    const cancelled = advanceManifest(prev.manifest, [], 2);
    expect(cancelled.advanced).toBe(false);
  });

  it("deduplicates overlapping pages by stable identity", () => {
    const r = advanceManifest(
      undefined,
      [
        { ok: true, entries: [entry("b", 2), entry("a", 1)], hasNextPage: true },
        { ok: true, entries: [entry("a", 3)], hasNextPage: false },
      ],
      3,
    );
    expect(r.manifest?.entries.map((e) => `${e.key}@${e.updatedAt}`)).toEqual(["a@3", "b@2"]);
  });

  it("classifies a 304 by HTTP status even though gh exits 1", () => {
    const out = classifyGh({
      exitCode: 1,
      stdout: 'HTTP/2.0 304 Not Modified\r\nEtag: W/"x"\r\n\r\n',
      stderr: "gh: HTTP 304",
    });
    expect(out).toEqual({ kind: "not-modified", status: 304 });
  });

  it("reads ETag and Last-Modified from a 200", () => {
    const out = classifyGh({
      exitCode: 0,
      stdout:
        'HTTP/2.0 200 OK\nEtag: W/"x"\nLast-Modified: Sat, 14 Nov 2026 18:22:58 GMT\n\n{"a":1}',
      stderr: "",
    });
    expect(out).toMatchObject({ kind: "ok", etag: 'W/"x"', body: '{"a":1}' });
  });

  it("recognises rate limiting and transport failures", () => {
    expect(
      classifyGh({
        exitCode: 1,
        stdout: "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 0\n\n{}",
        stderr: "",
      }),
    ).toEqual({ kind: "http-error", status: 403, rateLimited: true });
    expect(classifyGh({ exitCode: 1, stdout: "", stderr: "connection reset" })).toEqual({
      kind: "transport-error",
      message: "connection reset",
    });
  });

  it("stops on a secondary rate limit while primary quota remains", () => {
    expect(
      classifyGh({
        exitCode: 1,
        stdout:
          "HTTP/2.0 403 Forbidden\nRetry-After: 60\nX-Ratelimit-Remaining: 4900\n\n" +
          '{"message":"You have exceeded a secondary rate limit."}',
        stderr: "",
      }),
    ).toEqual({ kind: "http-error", status: 403, rateLimited: true });
    expect(
      classifyGh({
        exitCode: 1,
        stdout:
          "HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 4900\n\n" +
          '{"message":"You have exceeded a secondary rate limit"}',
        stderr: "",
      }),
    ).toMatchObject({ rateLimited: true });
    expect(
      classifyGh({
        exitCode: 1,
        stdout: 'HTTP/2.0 403 Forbidden\nX-Ratelimit-Remaining: 4900\n\n{"message":"no access"}',
        stderr: "",
      }),
    ).toMatchObject({ rateLimited: false });
  });

  it("reconciles with a full re-read after the interval instead of reusing old facts", () => {
    const previous = baselineWorld();
    const next = baselineWorld();
    next.now += RECONCILE_MINUTES + 1;
    const c = warmRefresh("manifest+live", previous, next);
    expect(c.reconciliations).toBe(1);
    expect(c.validatedHits).toBe(0);
    const inside = baselineWorld();
    inside.now += RECONCILE_MINUTES - 1;
    expect(warmRefresh("manifest+live", previous, inside).reconciliations).toBe(0);
  });

  it("reuses a 304 only for the exact stored resource, validator and context", () => {
    const stored = { contextKey: "ctx", etag: 'W/"x"', body: "B" };
    const nm = { kind: "not-modified", status: 304 } as const;
    expect(applyConditional(stored, "ctx", 'W/"x"', nm)).toEqual({ kind: "validated", body: "B" });
    expect(applyConditional(undefined, "ctx", 'W/"x"', nm).kind).toBe("miss");
    expect(applyConditional(stored, "other", 'W/"x"', nm).kind).toBe("miss");
    expect(applyConditional(stored, "ctx", 'W/"y"', nm).kind).toBe("miss");
    expect(
      applyConditional(stored, "ctx", 'W/"x"', {
        kind: "http-error",
        status: 502,
        rateLimited: false,
      }),
    ).toEqual({ kind: "miss", reason: "HTTP 502" });
  });
});
