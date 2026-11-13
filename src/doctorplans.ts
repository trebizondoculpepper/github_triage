/**
 * Ticket Doctor v2 (#67): deterministic correction plans for v1 findings.
 * Contract: doc/design/diagnostics.md, "#67: Ticket Doctor v2".
 *
 * Plans are suggestions only; nothing here runs a command. Every executable step is an argv
 * of a delivered command (github-triage, or a plain `gh issue edit` when no triage command
 * covers the label change), with --repo inside it. Human judgment is marked with `<UPPER>`
 * placeholders and listed per step; semantic choices are alternatives, never one pick.
 * Claim mutations are only ever addressed to the claimant themselves.
 */

/** The executable that the suggestions name (package.json "bin"). */
export const triageCommand = "github-triage";

/**
 * `command`: a delivered github-triage mutation. `inspect`: a read-only command.
 * `manual`: no triage command covers it, so a plain `gh` edit is suggested instead.
 */
export type StepKind = "command" | "inspect" | "manual";
export interface CorrectionStep {
  kind: StepKind;
  /** Alternative name when the plan is a choice (e.g. keep-high); absent for plain steps. */
  choice?: string;
  description: string;
  argv: string[];
  /** Shell-quoted argv; no comments, every argument inside it. */
  command: string;
  /** `<UPPER>` tokens in argv that a person or agent must fill in. */
  placeholders: string[];
  /** Who may run it; absent means anyone with repository write access. */
  runBy?: string;
  preconditions: string[];
}
export interface CorrectionPlan {
  /** True when the steps are alternatives that need a judgment, not one definite fix. */
  judgment: boolean;
  /** Facts the plan relies on (beyond the finding's detail), e.g. a cycle path. */
  facts: string[];
  steps: CorrectionStep[];
}

const safe = /^[\w@%+=:,./-]+$/;
/** POSIX shell quoting; deterministic and comment-free. */
export const shellQuote = (argv: string[]): string =>
  argv.map((a) => (safe.test(a) ? a : `'${a.replaceAll("'", `'\\''`)}'`)).join(" ");

const step = (
  kind: StepKind,
  description: string,
  argv: string[],
  extra: { choice?: string; runBy?: string; preconditions?: string[] } = {},
): CorrectionStep => ({
  kind,
  ...(extra.choice ? { choice: extra.choice } : {}),
  description,
  argv,
  command: shellQuote(argv),
  placeholders: [...new Set(argv.flatMap((a) => a.match(/<[A-Z_]+>/g) ?? []))],
  ...(extra.runBy ? { runBy: extra.runBy } : {}),
  preconditions: extra.preconditions ?? [],
});

/** Builders for each delivered command, kept in one place so syntax matches `--help`. */
export function planCommands(repository: string) {
  const repo = ["--repo", repository];
  const triage = (...args: string[]): string[] => [triageCommand, ...args, ...repo];
  const gh = (number: number, add: string[], remove: string[]): string[] => [
    "gh",
    "issue",
    "edit",
    String(number),
    ...repo,
    ...add.flatMap((l) => ["--add-label", l]),
    ...remove.flatMap((l) => ["--remove-label", l]),
  ];
  const claimant = (agent: string) => `agent ${agent} only (the claimant)`;
  const own = (agent: string) =>
    `Run only by ${agent}; never release or take over another agent's claim. Inactivity is not permission.`;
  return {
    inspectIssue: (n: number) =>
      step("inspect", `Read #${n} in full.`, triage("--issue", String(n), "--json")),
    who: (n: number) => step("inspect", `Who is working on #${n}?`, triage("who", String(n))),
    team: () => step("inspect", "Review every agent's claims and activity.", triage("team")),
    pr: (n: number) => step("inspect", `Why is PR #${n} not progressing?`, triage("pr", String(n))),
    deps: (n: number, tree = false) =>
      step(
        "inspect",
        `Read native dependencies of #${n}${tree ? " transitively" : ""}.`,
        triage("deps", String(n), ...(tree ? ["--tree"] : [])),
      ),
    labels: (
      n: number,
      add: string[],
      remove: string[],
      description: string,
      extra: { choice?: string; runBy?: string; preconditions?: string[] } = {},
    ) => step("manual", description, gh(n, add, remove), extra),
    release: (
      n: number,
      agent: string,
      outcome: "ready" | "incomplete" | "done",
      description: string,
      extra: { pr?: string; choice?: string } = {},
    ) =>
      step(
        "command",
        description,
        triage(
          "release",
          String(n),
          "--agent",
          agent,
          "--as",
          outcome,
          "--note",
          "<NOTE>",
          ...(extra.pr ? ["--pr", extra.pr] : []),
        ),
        { choice: extra.choice ?? outcome, runBy: claimant(agent), preconditions: [own(agent)] },
      ),
    estimate: (n: number) =>
      step(
        "command",
        `Record the size of #${n} you judge correct; it replaces every other size label.`,
        triage("estimate", String(n), "--size", "<SIZE>", "--rationale", "<RATIONALE>"),
        {
          preconditions: [
            "Justify the size you assign; earlier estimates need no explanation or permission.",
          ],
        },
      ),
    needsHuman: (n: number) =>
      step(
        "command",
        `Record why #${n} is blocked as questions for a designer.`,
        triage(
          "needs-human",
          String(n),
          "--agent",
          "<YOUR_AGENT>",
          "--designer",
          "<DESIGNER>",
          "--why",
          "<WHY>",
          "--question",
          "<QUESTION>",
        ),
        {
          choice: "ask",
          preconditions: ["Refused if another agent holds the claim; use your own identity."],
        },
      ),
    depsChange: (
      action: "add" | "remove",
      n: number,
      on: number,
      description: string,
      choice: string,
    ) =>
      step(
        "command",
        description,
        triage("deps", action, String(n), "--on", String(on), "--note", "<WHY>"),
        {
          choice,
          preconditions: [
            "Run with --dry-run first; the command re-checks live state and refuses cycles.",
          ],
        },
      ),
  };
}
