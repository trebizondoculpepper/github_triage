/**
 * Optional proactive polling and deterministic domain events (doc/design/polling-events.md, #32).
 *
 * One watcher per MCP server process watches one explicitly selected repository. It reuses the
 * shared collector and the registered workflow rules/ranking: it never interprets prose, calls
 * an LLM, writes to GitHub, claims, merges or changes authority. Detection is independent of
 * delivery: events go to a bounded process-local log read on demand and to in-process
 * subscribers (future delivery adapters); neither is a wake-up promise.
 */
import { createHash, randomUUID } from "node:crypto";
import { analysisRules, prChecks, workflow } from "../briefing.js";
import { RateLimitError } from "../dependencies.js";
import type { collect as collectFn } from "../github.js";
import { closingPrEvidence, pickupEligibility } from "../ranking.js";
import type { Issue, Snapshot } from "../types.js";

export const eventKinds = [
  "attention-requested",
  "review-feedback",
  "verification-problem",
  "pr-follow-up-ready",
  "work-became-eligible",
] as const;
export type EventKind = (typeof eventKinds)[number];

/** Contract defaults: 30-minute interval, 1,000 events and 24 hours of process-local history. */
/** Longest accepted poll interval (24 hours), in minutes. */
export const maxPollIntervalMinutes = 1440;
/** setTimeout's largest safe delay; longer delays are chunked so Node never clamps them to 1 ms. */
export const maxTimerDelayMs = 2 ** 31 - 1;

export const pollingDefaults = {
  intervalMinutes: 30,
  maxEvents: 1000,
  maxAgeMs: 24 * 60 * 60 * 1000,
  /** Bound on one collection; the collector's gh child processes are aborted after it. */
  pollTimeoutMs: 10 * 60 * 1000,
  baseBackoffMs: 60 * 1000,
  maxBackoffMs: 60 * 60 * 1000,
  /** Bound on remembered fact generations (recurrence detection). */
  maxGenerations: 20000,
};

export const baselineRule =
  "The first complete observation after this process started is the baseline and emits no historical events. Later polls compare against the last complete observation; failed or incomplete polls never replace it. Each subject's baseline is established or replaced only from complete evidence for that subject; the first complete observation of a subject previously seen only incompletely establishes it silently. A restart starts a new baseline; nothing that happened while no process was watching is reconstructed.";

export const pollingLimitations = [
  "History lives only in this MCP server process and is lost when it exits.",
  "Each server process started with --poll polls independently; several processes duplicate requests.",
  "Receiving or reading an event is not a wake-up, acknowledgement or evidence that an agent acted.",
  "Events are inspection candidates, never approval, claims or merge authority.",
];

/** A versioned domain event (doc/design/polling-events.md, "Event schema and relevance"). */
export interface DomainEvent {
  schemaVersion: 1;
  eventId: string;
  sequence: number;
  repository: string;
  subject: { number: number; kind: "issue" | "pull-request"; url: string };
  kind: EventKind;
  observedAt: string;
  sourceEventAt: string | null;
  evidence: string[];
  currentSha: string | null;
  reviewedSha: string | null;
  reason: string;
  destinations: string[];
  origin: string | null;
  completeness: { complete: boolean; uncertainty: string | null };
}

/** One fact supporting a possible event; `key` is its stable identity within a subject. */
interface Fact {
  key: string;
  kind: EventKind;
  evidence: string[];
  sourceEventAt: string | null;
  currentSha: string | null;
  reviewedSha: string | null;
  reason: string;
  destinations: string[];
  origin: string | null;
}

interface SubjectObservation {
  number: number;
  kind: "issue" | "pull-request";
  url: string;
  facts: Map<string, Fact>;
  /** Pickup eligibility under the shared ranking policy (issues only). */
  eligibility: "eligible" | "unknown" | "ineligible" | null;
  /** Whether this subject's evidence was complete in the observation it came from. */
  complete: boolean;
}

/** Facts derived from one complete collection. */
export interface Observation {
  observedAt: string;
  subjects: Map<string, SubjectObservation>;
}

const labelNames = (item: Pick<Issue, "labels">): string[] =>
  item.labels.nodes.map(({ name }) => name);
const prefixed = (item: Pick<Issue, "labels">, prefix: string): string[] =>
  labelNames(item)
    .filter((name) => name.startsWith(prefix))
    .map((name) => name.slice(prefix.length));
const active = (item: Issue): boolean => workflow.openStates.includes(item.state);

/** A collection is globally incomplete when a warning is not attributable to one subject. */
function subjectWarnings(snapshot: Snapshot): { global: string[]; urls: Set<string> } {
  const urls = [...snapshot.issues, ...snapshot.pullRequests].map((item) => item.url);
  const global: string[] = [];
  const attributed = new Set<string>();
  for (const warning of snapshot.warnings) {
    const url = urls.find((candidate) => warning.startsWith(`${candidate}:`));
    if (url) attributed.add(url);
    else global.push(warning);
  }
  return { global, urls: attributed };
}

/** Check outcome classes kept distinct (failed, cancelled, unknown); pending is never a problem. */
function checkProblem(outcome: string): "failed" | "cancelled" | "unknown" | null {
  if (outcome === "CANCELLED") return "cancelled";
  if (workflow.failure.includes(outcome)) return "failed";
  if (workflow.unfinished.includes(outcome) || workflow.pass.includes(outcome)) return null;
  return "unknown";
}

/**
 * Derive normalized facts from a collected snapshot through the shared rules and ranking
 * policy. Returns null facts for subjects whose evidence is incomplete (they keep their
 * previous baseline facts instead of being treated as absent).
 */
export function observe(snapshot: Snapshot, observedAt: string): Observation {
  const { urls: incomplete } = subjectWarnings(snapshot);
  const issues = snapshot.issues.filter(active);
  const prs = snapshot.pullRequests.filter(active);
  const prRule = analysisRules.get("pull-requests");
  const inspectable = new Set(
    (prRule ? prRule({ snapshot, issues, prs }) : [])
      .filter((action) => action.rule === "pr-inspect-merge")
      .map((action) => action.target),
  );
  // Cross-subject evidence: an issue's eligibility rests on the closing link (closingPrEvidence,
  // shared with pickup ranking). When an open PR's references are truncated and the issue's
  // own reverse link cannot prove absence, the issue's evidence is incomplete for this poll.
  const subjects = new Map<string, SubjectObservation>();
  const add = (
    item: Issue,
    kind: SubjectObservation["kind"],
    eligibility: SubjectObservation["eligibility"],
    complete = !incomplete.has(item.url),
  ) => {
    const subject: SubjectObservation = {
      number: item.number,
      kind,
      url: item.url,
      facts: new Map(),
      eligibility,
      complete,
    };
    subjects.set(item.url, subject);
    return subject;
  };
  const put = (subject: SubjectObservation, fact: Fact) => subject.facts.set(fact.key, fact);
  const attention = (subject: SubjectObservation, item: Issue) => {
    const origin = prefixed(item, "origin:");
    for (const name of prefixed(item, "attention:"))
      put(subject, {
        key: `attention/${name}`,
        kind: "attention-requested",
        evidence: [item.url],
        sourceEventAt: null,
        currentSha: null,
        reviewedSha: null,
        reason: `Label attention:${name} requests ${name}'s attention. The addressed name is a destination, not an owner or reservation.`,
        destinations: [name],
        origin: origin.length === 1 ? origin[0] : null,
      });
  };

  for (const issue of issues) {
    const eligibility = pickupEligibility(issue, { prs }).status;
    const subject = add(
      issue,
      "issue",
      eligibility,
      !incomplete.has(issue.url) && closingPrEvidence(issue, prs).complete,
    );
    attention(subject, issue);
    if (eligibility === "eligible")
      put(subject, {
        key: "eligible",
        kind: "work-became-eligible",
        evidence: [issue.url],
        sourceEventAt: null,
        currentSha: null,
        reviewedSha: null,
        reason:
          "Previously ineligible work is now eligible under the shared pickup policy (ready, unclaimed, no open native blocker or closing PR). Recheck ownership before claiming.",
        destinations: [],
        origin: null,
      });
  }

  for (const pr of prs) {
    const linked = issues.filter((issue) =>
      pr.closingIssuesReferences.nodes.some((ref) => ref.url === issue.url),
    );
    // A PR's routed destinations come from its linked issues' owner labels, so truncated
    // evidence on a linked issue leaves the PR's facts incomplete too.
    const subject = add(
      pr,
      "pull-request",
      null,
      !incomplete.has(pr.url) && linked.every((issue) => !incomplete.has(issue.url)),
    );
    attention(subject, pr);
    const head = pr.headRefOid;
    const routed = [
      ...new Set([pr, ...linked].flatMap((item) => prefixed(item, workflow.ownerPrefix))),
    ].sort();
    for (const thread of pr.reviewThreads.nodes) {
      const first = thread.comments.nodes[0];
      if (thread.isResolved || !first?.url) continue;
      put(subject, {
        key: `thread/${first.url}`,
        kind: "review-feedback",
        evidence: [first.url],
        sourceEventAt: first.createdAt ?? null,
        currentSha: head,
        reviewedSha: null,
        reason: `Unresolved review thread${thread.isOutdated ? " (outdated against the current head)" : ""}.`,
        destinations: routed,
        origin: null,
      });
    }
    for (const review of pr.reviews.nodes)
      if (workflow.changesRequested.includes(review.state) && review.url)
        put(subject, {
          key: `review/${review.url}`,
          kind: "review-feedback",
          evidence: [review.url],
          sourceEventAt: review.createdAt ?? null,
          currentSha: head,
          reviewedSha: null,
          reason: "A review requested changes.",
          destinations: routed,
          origin: null,
        });
    const contexts = pr.commits.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? [];
    for (const [index, check] of prChecks(pr).entries()) {
      const problem = checkProblem(check.outcome);
      if (!problem) continue;
      // A stable per-run identity keeps same-named checks (other workflows, re-runs on the
      // same head) distinct, while an unchanged run still deduplicates across polls.
      const source = contexts[index];
      const identity = source?.databaseId != null ? `run:${source.databaseId}` : `url:${check.url}`;
      put(subject, {
        key: `check/${head}/${check.name}/${identity}/${problem}`,
        kind: "verification-problem",
        evidence: [check.url],
        sourceEventAt: null,
        currentSha: head,
        reviewedSha: null,
        reason: `Current-head check ${check.name} is ${problem} (${check.outcome}).`,
        destinations: routed,
        origin: null,
      });
    }
    if (workflow.conflicts.includes(pr.mergeable))
      put(subject, {
        key: `conflict/${head}`,
        kind: "verification-problem",
        evidence: [pr.url],
        sourceEventAt: null,
        currentSha: head,
        reviewedSha: null,
        reason: "GitHub reports merge conflicts for the current head.",
        destinations: routed,
        origin: null,
      });
    if (inspectable.has(pr.url))
      put(subject, {
        key: `ready/${head}`,
        kind: "pr-follow-up-ready",
        evidence: [pr.url],
        sourceEventAt: null,
        currentSha: head,
        reviewedSha: null,
        reason:
          "Current-head verify passes with no fetched blocking findings: a candidate for review/merge inspection, never merge approval.",
        destinations: routed,
        origin: null,
      });
  }
  return { observedAt, subjects };
}

/** Reliable operation identity for exact echoes of an agent's own mechanical writes. */
export interface OperationOrigins {
  /** The agent whose own tool operation produced exactly this fact, or null when unknown. */
  echoOf(repository: string, subjectUrl: string, factKey: string): string | null;
}
const noOrigins: OperationOrigins = { echoOf: () => null };

/**
 * Compare a new observation to the baseline. A subject's baseline facts are only ever
 * established or replaced from complete evidence for that subject, and events are drafted only
 * when both the prior and the current observation of that subject are complete:
 * - current incomplete: keep a complete prior baseline unchanged; otherwise record the subject
 *   as still lacking a complete baseline (so its later first sight is not "new");
 * - current complete, prior incomplete: establish the subject's baseline silently, like a
 *   first run (`established`), because the prior facts may be artefacts of truncation;
 * - current complete, prior complete: diff and draft events;
 * - current complete, no prior: a subject first seen after the baseline, diffed against nothing.
 * Returns the next baseline as well.
 */
export function diffObservations(
  baseline: Observation,
  next: Observation,
): {
  drafts: { subject: SubjectObservation; fact: Fact }[];
  established: SubjectObservation[];
  merged: Observation;
} {
  const drafts: { subject: SubjectObservation; fact: Fact }[] = [];
  const established: SubjectObservation[] = [];
  const merged = new Map<string, SubjectObservation>();
  for (const [url, subject] of next.subjects) {
    const before = baseline.subjects.get(url);
    if (!subject.complete) {
      // Missing or truncated evidence is unknown, never absence: carry a complete baseline
      // forward, and never let incomplete facts become one.
      merged.set(url, before?.complete ? before : subject);
      continue;
    }
    merged.set(url, subject);
    if (before && !before.complete) {
      established.push(subject);
      continue;
    }
    for (const fact of subject.facts.values()) {
      if (before?.facts.has(fact.key)) continue;
      // Only a known-ineligible -> eligible transition counts; first sight is not a transition.
      if (fact.kind === "work-became-eligible" && before?.eligibility !== "ineligible") continue;
      drafts.push({ subject, fact });
    }
  }
  return { drafts, established, merged: { observedAt: next.observedAt, subjects: merged } };
}

/** Opaque cursor: process generation and sequence. */
const encodeCursor = (generation: string, sequence: number): string =>
  Buffer.from(`${generation}:${sequence}`).toString("base64url");
function decodeCursor(cursor: string): { generation: string; sequence: number } | null {
  const text = Buffer.from(cursor, "base64url").toString();
  const match = /^([\w-]+):(\d+)$/.exec(text);
  return match ? { generation: match[1], sequence: Number(match[2]) } : null;
}

/** Bounded, nondestructive process-local event history. */
export class EventLog {
  private items: DomainEvent[] = [];
  private nextSequence = 1;
  /** Events dropped by either bound since the process started. */
  evicted = 0;

  constructor(
    readonly generation: string,
    private readonly now: () => Date,
    private readonly maxEvents = pollingDefaults.maxEvents,
    private readonly maxAgeMs = pollingDefaults.maxAgeMs,
  ) {}

  append(event: Omit<DomainEvent, "sequence">): DomainEvent {
    const stored = { ...event, sequence: this.nextSequence++ };
    this.items.push(stored);
    this.prune();
    return stored;
  }

  has(eventId: string): boolean {
    return this.items.some((item) => item.eventId === eventId);
  }

  get size(): number {
    this.prune();
    return this.items.length;
  }

  private prune(): void {
    const cutoff = this.now().getTime() - this.maxAgeMs;
    let drop = Math.max(0, this.items.length - this.maxEvents);
    while (drop < this.items.length && Date.parse(this.items[drop].observedAt) < cutoff) drop++;
    if (drop) {
      this.items = this.items.slice(drop);
      this.evicted += drop;
    }
  }

  /** Read after an optional cursor. Gaps and unknown cursors require a reset, never a skip. */
  read(
    cursor: string | undefined,
    limit: number,
  ): {
    items: DomainEvent[];
    nextCursor: string;
    more: boolean;
    resetRequired: boolean;
    gap: string | null;
  } {
    this.prune();
    const head = this.nextSequence - 1;
    const first = this.items[0]?.sequence ?? this.nextSequence;
    const reset = (gap: string) => ({
      items: [],
      nextCursor: encodeCursor(this.generation, head),
      more: false,
      resetRequired: true,
      gap,
    });
    let after = first - 1;
    let gap: string | null = null;
    if (cursor !== undefined) {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.generation !== this.generation)
        return reset(
          "Cursor is from another server process or is not a cursor; event history before this process is unavailable.",
        );
      if (decoded.sequence > head) return reset("Cursor is ahead of this process's history.");
      if (decoded.sequence < first - 1)
        return reset(
          `Events after this cursor were evicted by the ${this.maxEvents}-event/24-hour bound.`,
        );
      after = decoded.sequence;
    } else if (this.evicted) {
      gap = `${this.evicted} older event(s) were evicted by the ${this.maxEvents}-event/24-hour bound before this read.`;
    }
    const pending = this.items.filter((item) => item.sequence > after);
    const items = pending.slice(0, limit);
    return {
      items,
      nextCursor: encodeCursor(this.generation, items.at(-1)?.sequence ?? after),
      more: pending.length > items.length,
      resetRequired: false,
      gap,
    };
  }
}

/** Timer boundary, injected so tests drive a fake clock. */
export interface Clock {
  now(): Date;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => chunkedTimeout(callback, ms),
  clearTimeout: (handle) => (handle as { cancel(): void }).cancel(),
};

/**
 * Schedule after any delay: Node clamps delays above 2^31-1 ms to 1 ms, so longer waits run as
 * successive bounded timers. Each timer is unref'd so it never keeps the process alive alone.
 */
export function chunkedTimeout(
  callback: () => void,
  ms: number,
  timers: {
    set(run: () => void, ms: number): ReturnType<typeof setTimeout>;
    clear(handle: ReturnType<typeof setTimeout>): void;
  } = { set: (run, delay) => setTimeout(run, delay), clear: (handle) => clearTimeout(handle) },
): { cancel(): void } {
  let remaining = Math.max(0, ms);
  let handle: ReturnType<typeof setTimeout>;
  const arm = () => {
    const step = Math.min(remaining, maxTimerDelayMs);
    remaining -= step;
    handle = timers.set(() => (remaining > 0 ? arm() : callback()), step);
    handle.unref?.();
  };
  arm();
  return { cancel: () => timers.clear(handle) };
}

export type Collect = typeof collectFn;

export interface WatcherRuntime {
  collect: Collect;
  clock: Clock;
  /** Jitter source in [0, 1). */
  random?: () => number;
  /** Opaque process generation for cursors. */
  generation?: string;
  origins?: OperationOrigins;
}

export interface WatcherOptions {
  repository: string;
  intervalMinutes?: number;
  limits?: Partial<typeof pollingDefaults>;
}

export type PollOutcome = "complete" | "incomplete" | "failed" | "rate-limited" | "cancelled";

export interface WatcherStatus {
  enabled: true;
  repository: string;
  state: "baseline-pending" | "watching" | "backoff" | "stopped";
  intervalMinutes: number;
  collecting: boolean;
  baselineAt: string | null;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastOutcome: PollOutcome | null;
  nextDueAt: string | null;
  backoff: { consecutiveFailures: number; until: string | null; reason: string | null };
  lastRequestCount: number | null;
  stale: boolean;
  suppressedEchoes: number;
  /** Subjects still lacking a baseline established from complete evidence. */
  incompleteSubjects: number;
  baselineRule: string;
}

/** The earliest retry time a rate-limited failure reported, if any. */
function retryDeadline(error: RateLimitError, now: Date): string | null {
  const times = [
    error.retry.retryAfterSeconds != null
      ? now.getTime() + error.retry.retryAfterSeconds * 1000
      : NaN,
    error.retry.resetAt ? Date.parse(error.retry.resetAt) : NaN,
  ].filter(Number.isFinite);
  return times.length ? new Date(Math.max(...times)).toISOString() : null;
}
const rateLimitPattern = /rate limit|secondary rate|abuse detection|retry-after/i;

/** Per-repository poller owned by one MCP server process. */
export class Watcher {
  readonly log: EventLog;
  private readonly limits: typeof pollingDefaults;
  private readonly intervalMs: number;
  private readonly random: () => number;
  private readonly origins: OperationOrigins;
  private baseline: Observation | null = null;
  private generations = new Map<string, number>();
  private timer: unknown = null;
  private inflight: Promise<PollOutcome> | null = null;
  private controller: AbortController | null = null;
  private stopped = false;
  private started = false;
  private subscribers = new Set<(event: DomainEvent) => void>();
  private lastAttemptAt: string | null = null;
  private lastSuccessAt: string | null = null;
  private lastOutcome: PollOutcome | null = null;
  private nextDueAt: string | null = null;
  private failures = 0;
  private backoffUntil: string | null = null;
  private backoffReason: string | null = null;
  private lastRequestCount: number | null = null;
  private resetAt: string | null = null;
  private suppressed = 0;

  constructor(
    readonly options: WatcherOptions,
    private readonly runtime: WatcherRuntime,
  ) {
    this.limits = { ...pollingDefaults, ...options.limits };
    const minutes = options.intervalMinutes ?? pollingDefaults.intervalMinutes;
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > maxPollIntervalMinutes)
      throw new Error(
        `Poll interval must be a whole number of minutes from 1 to ${maxPollIntervalMinutes}.`,
      );
    this.intervalMs = minutes * 60 * 1000;
    this.random = runtime.random ?? Math.random;
    this.origins = runtime.origins ?? noOrigins;
    this.log = new EventLog(
      runtime.generation ?? randomUUID(),
      () => runtime.clock.now(),
      this.limits.maxEvents,
      this.limits.maxAgeMs,
    );
  }

  get repository(): string {
    return this.options.repository;
  }

  /** Typed in-process events for future delivery adapters; returns an unsubscribe function. */
  subscribe(listener: (event: DomainEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  /** Start the first bounded collection; later polls follow completion, never overlapping. */
  start(): void {
    if (this.started || this.stopped) return;
    this.started = true;
    this.schedule(0);
  }

  /** Stop scheduling and abort outstanding collection. Idempotent; nothing runs afterwards. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.runtime.clock.clearTimeout(this.timer);
    this.timer = null;
    this.nextDueAt = null;
    this.controller?.abort();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) this.runtime.clock.clearTimeout(this.timer);
    this.nextDueAt = new Date(this.runtime.clock.now().getTime() + delayMs).toISOString();
    this.timer = this.runtime.clock.setTimeout(() => {
      this.timer = null;
      void this.poll();
    }, delayMs);
  }

  /** Run one poll now, or join the one in flight (no overlap). */
  poll(): Promise<PollOutcome> {
    if (this.stopped) return Promise.resolve("cancelled");
    this.inflight ??= this.runPoll().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async runPoll(): Promise<PollOutcome> {
    const clock = this.runtime.clock;
    this.lastAttemptAt = clock.now().toISOString();
    this.nextDueAt = null;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = clock.setTimeout(() => controller.abort(), this.limits.pollTimeoutMs);
    let outcome: PollOutcome;
    try {
      const snapshot = await this.runtime.collect(this.repository, { signal: controller.signal });
      if (snapshot.metrics) this.lastRequestCount = snapshot.metrics.requestCount;
      this.resetAt =
        snapshot.rateLimit && snapshot.rateLimit.remaining <= 0 ? snapshot.rateLimit.resetAt : null;
      outcome = this.absorb(snapshot);
    } catch (error) {
      if (this.stopped || controller.signal.aborted)
        outcome = this.stopped ? "cancelled" : "failed";
      else if (error instanceof RateLimitError) {
        outcome = "rate-limited";
        this.resetAt = retryDeadline(error, clock.now()) ?? this.resetAt;
      } else
        outcome = rateLimitPattern.test(error instanceof Error ? error.message : String(error))
          ? "rate-limited"
          : "failed";
    } finally {
      clock.clearTimeout(timeout);
      this.controller = null;
    }
    this.lastOutcome = outcome;
    if (this.stopped) return "cancelled";
    if (outcome === "complete" || outcome === "incomplete") {
      if (outcome === "complete") {
        this.failures = 0;
        this.backoffUntil = null;
        this.backoffReason = null;
      }
      // A successful read with an exhausted quota still waits for GitHub's reset time.
      this.schedule(Math.max(this.intervalMs, this.untilReset()));
    } else this.backoff(outcome);
    return outcome;
  }

  private untilReset(): number {
    if (!this.resetAt) return 0;
    return Math.max(0, Date.parse(this.resetAt) - this.runtime.clock.now().getTime());
  }

  /** Bounded exponential backoff with jitter; never retry before a known rate-limit reset. */
  private backoff(outcome: PollOutcome): void {
    this.failures++;
    const exponential = Math.min(
      this.limits.maxBackoffMs,
      this.limits.baseBackoffMs * 2 ** (this.failures - 1),
    );
    const jittered = Math.round(exponential * (0.5 + this.random() * 0.5));
    const delay = Math.max(jittered, this.untilReset());
    this.backoffUntil = new Date(this.runtime.clock.now().getTime() + delay).toISOString();
    this.backoffReason =
      outcome === "rate-limited"
        ? "GitHub rate limit reported; waiting for backoff/reset before retrying."
        : "Collection failed; retrying with bounded backoff.";
    this.schedule(delay);
  }

  /** Fold one snapshot into the baseline; returns whether it was complete. */
  private absorb(snapshot: Snapshot): PollOutcome {
    const { global } = subjectWarnings(snapshot);
    // A repository-level gap (truncation, missing pages) makes the whole observation unknown.
    if (global.length) return "incomplete";
    const now = this.runtime.clock.now().toISOString();
    const next = observe(snapshot, now);
    // A subject-scoped gap still leaves that subject without a trustworthy baseline, so the
    // poll is reported as incomplete rather than describing the observation as complete.
    const outcome: PollOutcome = [...next.subjects.values()].every((subject) => subject.complete)
      ? "complete"
      : "incomplete";
    if (!this.baseline) {
      this.baseline = next;
      this.seedGenerations([...next.subjects.values()].filter((subject) => subject.complete));
      this.firstBaselineAt = now;
      this.lastSuccessAt = now;
      return outcome;
    }
    const { drafts, established, merged } = diffObservations(this.baseline, next);
    this.seedGenerations(established);
    for (const { subject, fact } of drafts) this.emit(subject, fact, now);
    this.baseline = merged;
    this.lastSuccessAt = now;
    return outcome;
  }

  /** Subjects whose baseline is not yet established from complete evidence. */
  private incompleteSubjects(): number {
    if (!this.baseline) return 0;
    return [...this.baseline.subjects.values()].filter((subject) => !subject.complete).length;
  }

  /**
   * Baseline facts start at generation 1, so a fact that genuinely clears and recurs gets a
   * new identity while repeated observation of an unchanged fact never re-emits.
   */
  private seedGenerations(subjects: Iterable<SubjectObservation>): void {
    for (const subject of subjects)
      for (const key of subject.facts.keys()) this.generations.set(`${subject.url}#${key}`, 1);
    this.boundGenerations();
  }

  private boundGenerations(): void {
    while (this.generations.size > this.limits.maxGenerations) {
      const oldest = this.generations.keys().next().value;
      if (oldest === undefined) break;
      this.generations.delete(oldest);
    }
  }

  private emit(subject: SubjectObservation, fact: Fact, observedAt: string): void {
    const id = `${subject.url}#${fact.key}`;
    const generation = (this.generations.get(id) ?? 0) + 1;
    this.generations.delete(id);
    this.generations.set(id, generation);
    this.boundGenerations();
    const eventId = createHash("sha256")
      .update(
        JSON.stringify([
          this.repository,
          subject.kind,
          subject.number,
          fact.kind,
          fact.key,
          generation,
        ]),
      )
      .digest("hex")
      .slice(0, 32);
    if (this.log.has(eventId)) return;
    let destinations = fact.destinations;
    let origin = fact.origin;
    const echo = this.origins.echoOf(this.repository, subject.url, fact.key);
    if (echo) {
      origin = echo;
      // Reviewer feedback is never a mechanical echo; other destinations always remain.
      if (fact.kind !== "review-feedback") {
        destinations = destinations.filter((name) => name !== echo);
        if (fact.destinations.length && !destinations.length) {
          this.suppressed++;
          return;
        }
      }
    }
    const event = this.log.append({
      schemaVersion: 1,
      eventId,
      repository: this.repository,
      subject: { number: subject.number, kind: subject.kind, url: subject.url },
      kind: fact.kind,
      observedAt,
      sourceEventAt: fact.sourceEventAt,
      evidence: fact.evidence,
      currentSha: fact.currentSha,
      reviewedSha: fact.reviewedSha,
      reason: fact.reason,
      destinations,
      origin,
      completeness: {
        complete: true,
        uncertainty:
          fact.kind === "pr-follow-up-ready" || fact.kind === "work-became-eligible"
            ? "Candidate for inspection under the shared policy; recheck current GitHub state before acting."
            : null,
      },
    });
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // A delivery adapter failure never affects detection or the event history.
      }
    }
  }

  status(): WatcherStatus {
    const now = this.runtime.clock.now().getTime();
    const backingOff = !!this.backoffUntil && Date.parse(this.backoffUntil) > now;
    return {
      enabled: true,
      repository: this.repository,
      state: this.stopped
        ? "stopped"
        : backingOff
          ? "backoff"
          : this.baseline
            ? "watching"
            : "baseline-pending",
      intervalMinutes: this.intervalMs / 60000,
      collecting: this.inflight !== null,
      baselineAt: this.firstBaselineAt,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessAt: this.lastSuccessAt,
      lastOutcome: this.lastOutcome,
      nextDueAt: this.nextDueAt,
      backoff: {
        consecutiveFailures: this.failures,
        until: backingOff ? this.backoffUntil : null,
        reason: backingOff ? this.backoffReason : null,
      },
      lastRequestCount: this.lastRequestCount,
      stale:
        !this.lastSuccessAt || now - Date.parse(this.lastSuccessAt) > this.intervalMs * 2 + 60000,
      suppressedEchoes: this.suppressed,
      incompleteSubjects: this.incompleteSubjects(),
      baselineRule,
    };
  }
  private firstBaselineAt: string | null = null;
}

/** The read-only `triage_events` report (doc/design/polling-events.md). */
export function eventsReport(watcher: Watcher | null, cursor: string | undefined, limit: number) {
  if (!watcher)
    return {
      schemaVersion: 1 as const,
      kind: "events" as const,
      enabled: false,
      status: null,
      complete: false,
      guidance:
        "Polling is disabled. Restart pdb-mcp with --poll (and --repo) to watch a repository, or call triage_briefing (with since) for current evidence.",
      supportedDetectors: [...eventKinds],
      unsupportedDetectors: [],
      items: [],
      nextCursor: null,
      more: false,
      resetRequired: false,
      gap: null,
      limitations: pollingLimitations,
    };
  const status = watcher.status();
  const read = watcher.log.read(cursor, limit);
  const complete =
    !read.resetRequired &&
    !read.gap &&
    status.lastOutcome === "complete" &&
    status.baselineAt !== null &&
    !status.stale;
  return {
    schemaVersion: 1 as const,
    kind: "events" as const,
    enabled: true,
    repository: watcher.repository,
    status,
    complete,
    guidance: read.resetRequired
      ? "Event history cannot continue from this cursor. Call triage_briefing (with an explicit since) for current evidence, then continue from nextCursor."
      : status.baselineAt === null
        ? "No complete baseline yet; no events exist before it. Use triage_briefing for current evidence."
        : "Events are detection records for inspection, not approval or authority. Recheck current GitHub state before acting.",
    supportedDetectors: [...eventKinds],
    unsupportedDetectors: [],
    items: read.items,
    nextCursor: read.nextCursor,
    more: read.more,
    resetRequired: read.resetRequired,
    gap: read.gap,
    limitations: pollingLimitations,
  };
}
export type EventsReport = ReturnType<typeof eventsReport>;

export function eventsText(report: EventsReport): string {
  if (!report.enabled) return `${report.guidance}\n`;
  const status = report.status;
  const lines = [
    `Events for ${report.repository}: watcher ${status?.state}; last ${status?.lastOutcome ?? "none"} at ${status?.lastAttemptAt ?? "never"}; next ${status?.nextDueAt ?? "not scheduled"}.`,
  ];
  if (report.resetRequired) lines.push(`RESET REQUIRED: ${report.gap}`);
  else if (report.gap) lines.push(`Gap: ${report.gap}`);
  for (const event of report.items)
    lines.push(
      `- [${event.kind}] #${event.subject.number} ${event.reason}${event.destinations.length ? ` -> ${event.destinations.join(", ")}` : ""} ${event.evidence.join(" ")}`,
    );
  if (!report.items.length && !report.resetRequired) lines.push("No new events.");
  if (report.more) lines.push("More events are available after nextCursor.");
  lines.push(report.guidance);
  return `${lines.join("\n")}\n`;
}

/**
 * Coalesce simultaneous unfocused collections of the same repository (the poller and
 * unfocused briefing reads share one in-flight request with matching completeness). Focused or
 * incremental reads, and anything after completion, collect fresh: nothing is cached.
 */
export function sharedCollect(collect: Collect): Collect {
  const inflight = new Map<
    string,
    { promise: Promise<Snapshot>; controller: AbortController; waiters: number }
  >();
  return (repository, options) => {
    const { signal, ...rest } = options ?? {};
    if (Object.values(rest).some((value) => value !== undefined))
      return collect(repository, options);
    // A caller that is already cancelled never starts or joins a shared collection, so no
    // shared promise can be left rejecting without a handler.
    if (signal?.aborted)
      return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    let entry = inflight.get(repository);
    if (!entry) {
      const controller = new AbortController();
      const created = {
        controller,
        waiters: 0,
        promise: collect(repository, { signal: controller.signal })
          .catch((error: unknown) => {
            // A failed request rejects the collection while sibling requests may still be
            // paginating: abort them before the collection is forgotten, so retries never
            // overlap them and shutdown can stop them.
            controller.abort();
            throw error;
          })
          .finally(() => {
            if (inflight.get(repository) === created) inflight.delete(repository);
          }),
      };
      // Waiters observe the outcome through their own promises; this keeps an abandoned
      // shared collection (every waiter left) from becoming an unhandled rejection.
      created.promise.catch(() => {});
      entry = created;
      inflight.set(repository, created);
    }
    const shared = entry;
    shared.waiters++;
    return new Promise<Snapshot>((resolve, reject) => {
      let left = false;
      const leave = () => {
        if (left) return;
        left = true;
        signal?.removeEventListener("abort", onAbort);
        shared.waiters--;
      };
      const onAbort = () => {
        if (left) return;
        leave();
        // Abort the shared collection only when no other caller still waits for it.
        if (shared.waiters === 0) {
          shared.controller.abort();
          if (inflight.get(repository) === shared) inflight.delete(repository);
        }
        reject(signal?.reason ?? new Error("aborted"));
      };
      if (signal?.aborted) return onAbort();
      signal?.addEventListener("abort", onAbort, { once: true });
      shared.promise.then(
        (value) => {
          leave();
          resolve(value);
        },
        (error: unknown) => {
          leave();
          reject(error);
        },
      );
    });
  };
}
