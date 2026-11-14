/** Attributable review evidence shared by prstatus and both briefing engines (#182). */
import { selected } from "./github/github.js";
import type { CodexMarker } from "./prstatus.js";
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
  const head = pr.headRefOid;
  const codex = pr.comments.nodes
    .filter((c) => (c.author?.login ?? "").replace(/\[bot\]$/, "") === codexReviewer)
    .map((c) => codexMarker(c.body)?.code_review);
  // As in prstatus.ts: Codex findings on the current head block, whatever else approves it.
  if (codex.some((s) => s?.commit_sha === head && s.has_unresolved_findings === true)) return false;
  return (
    pr.reviews.nodes.some((r) => r.state === "APPROVED" && r.commit?.oid === head) ||
    pr.comments.nodes.some((c) => {
      if ((c.author?.login ?? "").replace(/\[bot\]$/, "") !== codexReviewer) return false;
      const state = codexMarker(c.body)?.code_review;
      return (
        state?.commit_sha === head &&
        state.status === "completed" &&
        state.has_unresolved_findings === false
      );
    })
  );
}
