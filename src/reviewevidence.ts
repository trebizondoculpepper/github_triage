/** Attributable review evidence shared by prstatus and both briefing engines (#182). */
import { selected } from "./github/github.js";
import type { CodexMarker, CodexReviewState } from "./prstatus.js";
import type { PullRequest } from "./github/types.js";

/** Codex's machine-readable review state embedded in a comment body, if any. */
export function codexMarker(body: string | null | undefined): CodexMarker | null {
  const m = /codex-review-state:v1 (\{.*?\}) -->/.exec(body ?? "");
  try {
    const parsed: unknown = m ? JSON.parse(m[1]) : null;
    return selected<CodexMarker>(parsed);
  } catch {
    return null;
  }
}

/** The account whose Codex review-state marker is attributable review evidence (#182). */
export const codexReviewer = "chatgpt-codex-connector";
/**
 * Attributable review evidence bound to the current head (#182 S9 acceptance): an APPROVED
 * review whose commit is the head, or a completed Codex review-state marker posted by the Codex
 * account for the head with findings explicitly false. Missing, pending, stale or unattributed
 * evidence is not acceptance, and a Codex receipt reporting findings on the head vetoes it.
 */
export function headReviewed(pr: PullRequest): boolean {
  return headAccepted(
    pr.headRefOid,
    pr.reviews.nodes.map((r) => ({ state: r.state, commit: r.commit?.oid ?? null })),
    pr.comments.nodes.map((c) => ({
      by: c.author?.login ?? "",
      state: codexMarker(c.body)?.code_review,
    })),
  );
}

/**
 * The same acceptance rule over plain review facts, so reports that do not hold a snapshot PR
 * (`pr N`'s status report) apply it identically rather than re-deriving it (#192).
 */
export function headAccepted(
  head: string,
  reviews: { state: string; commit: string | null }[],
  codexStates: { by: string; state: CodexReviewState | undefined }[],
): boolean {
  const codex = codexStates
    .filter((c) => c.by.replace(/\[bot\]$/, "") === codexReviewer)
    .map((c) => c.state);
  // As in prstatus.ts: Codex findings on the current head block, whatever else approves it.
  if (codex.some((s) => s?.commit_sha === head && s.has_unresolved_findings === true)) return false;
  return (
    reviews.some((r) => r.state === "APPROVED" && r.commit === head) ||
    codex.some(
      (s) =>
        s?.commit_sha === head && s.status === "completed" && s.has_unresolved_findings === false,
    )
  );
}
