/**
 * Claim and human-question commands (#2). Contract: doc/design/workflow.md, "One active
 * contribution", "Human questions" and "Actionable refusals".
 *
 * Each command reads live state first, plans its changes, and either refuses with a stable
 * error ID, facts, the failed prerequisite and recovery commands, or applies the plan through
 * the injected `gh` write boundary. Label names come from the registered workflow policy.
 */
import { createHash } from "node:crypto";
import { workflow } from "./briefing.js";
import { ghQuery } from "./github.js";
import { ghRun } from "./dependencies.js";

/** Labels these commands use, beyond the briefing's existing policy. */
export const claimPolicy = {
  owner: (agent) => `${workflow.ownerPrefix}${agent}`,
  /** An addressed response request (doc/design/briefings.md); never a claim. */
  attention: (name) => `attention:${name}`,
  /** Deliberate non-pickup states that a stale ready label must not override. */
  held: [workflow.blocked, workflow.parked],
  pickable: [workflow.ready, "status:incomplete"],
  needsDesign: "status:needs-design",
  decisionNeeded: "design:decision-needed",
  question: "question",
  platformPrefix: "platform:",
  questionsHeading: "### Questions for the designer",
  labelColours: {
    agent: "1d76db",
    "design:decision-needed": "d93f0b",
    "status:incomplete": "fbca04",
  },
};

/**
 * @typedef {{ step: string, command: string[], status?: string, reason?: string }} PlanStep
 * @typedef {{ ok: boolean, error?: string, facts: Record<string, any>, prerequisite?: string,
 *   recovery?: string[], noop?: boolean, reason?: string, changes?: PlanStep[],
 *   notes?: string[], recheck?: { agent: string } }} ClaimPlan
 * @typedef {ClaimPlan & { steps?: PlanStep[], conflict?: string | null, exitCode: number }} ClaimResult
 */

const marker = (kind, parts) =>
  `<!-- github-triage:${kind}:${createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 16)} -->`;

/** Live read of one ticket plus the agent's open claims. */
async function readTicket(repository, number, agent, query, designer = "") {
  const [owner, name] = repository.split("/");
  const data = await query(
    `query($owner:String!,$name:String!,$number:Int!,$label:String!,$question:String!,$decision:String!,$needsDesign:String!,$attention:String!){repository(owner:$owner,name:$name){issueOrPullRequest(number:$number){__typename ... on PullRequest{number url} ... on Issue{number title url state updatedAt labels(first:100){nodes{name} pageInfo{hasNextPage}} issueDependenciesSummary{blockedBy} blockedBy(first:20){nodes{number url state}} closedByPullRequestsReferences(first:10,includeClosedPrs:false){nodes{number url state}} comments(last:100){nodes{body createdAt}} timelineItems(itemTypes:[LABELED_EVENT],last:50){nodes{... on LabeledEvent{createdAt label{name}}}}}} claims:issues(first:20,states:OPEN,labels:[$label]){nodes{number title url}} ownerLabel:label(name:$label){name} questionLabel:label(name:$question){name} decisionLabel:label(name:$decision){name} needsDesignLabel:label(name:$needsDesign){name} attentionLabel:label(name:$attention){name}}}`,
    {
      owner,
      name,
      number,
      label: claimPolicy.owner(agent),
      question: claimPolicy.question,
      decision: claimPolicy.decisionNeeded,
      needsDesign: claimPolicy.needsDesign,
      attention: designer ? claimPolicy.attention(designer) : "",
    },
  );
  const repo = data.repository;
  if (!repo) throw new Error(`Repository unavailable: ${repository}`);
  return {
    item: repo.issueOrPullRequest ?? null,
    claims: repo.claims?.nodes ?? [],
    // Exact-name lookups, so a repository with many labels cannot hide an existing one.
    repoLabels: new Set(
      [
        repo.ownerLabel,
        repo.questionLabel,
        repo.decisionLabel,
        repo.needsDesignLabel,
        repo.attentionLabel,
      ]
        .filter(Boolean)
        .map((l) => l.name),
    ),
  };
}

/**
 * A refusal: stable ID, current facts, failed prerequisite, recovery commands. Recovery only
 * names implemented commands; anything else is marked as a manual step.
 * @returns {ClaimPlan}
 */
const refuse = (error, facts, prerequisite, recovery = []) => ({
  ok: false,
  error,
  facts,
  prerequisite,
  recovery,
});

const label = (item, name) => item.labels.nodes.some((l) => l.name === name);
const owners = (item) =>
  item.labels.nodes.map((l) => l.name).filter((n) => n.startsWith(workflow.ownerPrefix));

/**
 * Plan `claim N --agent NAME`. Reads only.
 * @returns {Promise<ClaimPlan>}
 */
export async function planClaim(repository, request, query = ghQuery) {
  const { number, agent, branch = null, platform = null } = request;
  const { item, claims, repoLabels } = await readTicket(repository, number, agent, query);
  const triage = `github-triage --repo ${repository}`;
  // Subcommands are dispatched on the first argument, so they must precede options.
  const command = (text) => `github-triage ${text} --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Only issues can be claimed; a pull request is reviewed or fixed, not claimed.",
      [`${triage} --issue ${number}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  };
  const mine = claimPolicy.owner(agent);
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Only an open ticket can be claimed.", [`${triage}`]);
  // Ownership is decided from the complete label set only.
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; ownership and readiness cannot be verified.",
      [`${triage} --issue ${number}`],
    );
  const others = facts.owners.filter((o) => o !== mine);
  if (others.length)
    return refuse(
      "OWNED_BY_OTHER",
      facts,
      `Already claimed by ${others.join(", ")}; never take over another agent's claim.`,
      [`${triage} --agent ${agent}`],
    );
  const ownOther = claims.filter((c) => c.number !== number);
  if (ownOther.length)
    return refuse(
      "OTHER_ACTIVE_CLAIM",
      { ...facts, activeClaims: ownOther.map((c) => ({ number: c.number, url: c.url })) },
      `${agent} already has an active claim; one active claim per agent.`,
      [
        ...ownOther.map(
          (c) =>
            `manual (release is #62, not yet implemented): gh issue edit ${c.number} --repo ${repository} --remove-label ${mine} --add-label status:incomplete   # or status:ready if untouched; then comment why`,
        ),
        command(`claim ${number} --agent ${agent}${branch ? ` --branch ${branch}` : ""}`),
      ],
    );
  const op = marker("claim", [repository, number, agent]);
  const claimComment = () => ({
    step: "comment",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`github-triage claim\`.\n\n${op}`,
    ],
  });
  if (label(item, mine)) {
    // Complete only when the explanatory comment exists too: a run whose comment failed is
    // repaired by retrying just that step.
    // This acquisition began when the label was last added; only a claim comment posted since
    // then counts, so an earlier claim's comment (before a release) does not.
    const since = (item.timelineItems?.nodes ?? [])
      .filter((e) => e.label?.name === mine)
      .map((e) => e.createdAt)
      .sort()
      .at(-1);
    const commented = item.comments.nodes.some(
      (c) => c.body.includes(op) && (!since || !c.createdAt || c.createdAt >= since),
    );
    return {
      ok: true,
      noop: commented,
      facts,
      reason: commented
        ? `Already claimed by ${agent}.`
        : `Claimed by ${agent}; posting the missing claim comment.`,
      changes: commented ? [] : [claimComment()],
      // Completing a partly failed acquisition gets the same post-write ownership check.
      ...(commented ? {} : { recheck: { agent } }),
    };
  }
  if (
    label(item, claimPolicy.question) ||
    label(item, claimPolicy.needsDesign) ||
    label(item, claimPolicy.decisionNeeded)
  )
    return refuse(
      "NOT_READY",
      facts,
      "The ticket has an outstanding question or design prerequisite.",
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  const held = claimPolicy.held.filter((l) => label(item, l));
  if (held.length)
    return refuse(
      "NOT_READY",
      facts,
      `The ticket is ${held.join(" and ")}; resolve that before claiming, even if a ready label remains.`,
      [`${triage} --issue ${number}`, `${triage} --agent ${agent}`],
    );
  if (!claimPolicy.pickable.some((l) => label(item, l)))
    return refuse(
      "NOT_READY",
      facts,
      `The ticket needs ${claimPolicy.pickable.join(" or ")} to be picked up.`,
      [`${triage} --agent ${agent}`],
    );
  if (!item.issueDependenciesSummary)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "Native blocker evidence is unavailable; readiness is unknown.",
      [command(`deps ${number}`)],
    );
  if (item.issueDependenciesSummary.blockedBy > 0)
    return refuse(
      "BLOCKED",
      {
        ...facts,
        openBlockers: item.blockedBy.nodes.filter((b) => b.state === "OPEN").map((b) => b.url),
      },
      "Open native blockers must close first.",
      [command(`deps ${number}`), `${triage} --agent ${agent}`],
    );
  const openPrs = item.closedByPullRequestsReferences.nodes.filter((p) => p.state === "OPEN");
  if (openPrs.length)
    return refuse(
      "HAS_OPEN_PR",
      { ...facts, pullRequests: openPrs.map((p) => p.url) },
      "An open pull request already addresses this ticket; follow up on it instead.",
      openPrs.map((p) => `gh pr view ${p.number} --repo ${repository}`),
    );
  const restrictions = facts.labels
    .filter((l) => l.startsWith(claimPolicy.platformPrefix))
    .map((l) => l.slice(claimPolicy.platformPrefix.length));
  if (restrictions.length && !platform)
    return refuse(
      "PLATFORM_UNKNOWN",
      { ...facts, platforms: restrictions },
      `The ticket is restricted to ${restrictions.join(", ")}; state your platform with --platform.`,
      [command(`claim ${number} --agent ${agent} --platform ${restrictions[0]}`)],
    );
  if (restrictions.length && !restrictions.includes(platform))
    return refuse(
      "PLATFORM_MISMATCH",
      { ...facts, platforms: restrictions, platform },
      `The ticket is restricted to ${restrictions.join(", ")}.`,
      [`${triage} --agent ${agent}`],
    );
  const remove = claimPolicy.pickable.filter((l) => label(item, l));
  // A fresh acquisition (label absent) always explains itself; retries of this acquisition are
  // handled above, where the label is already present.
  const changes = [];
  if (!repoLabels.has(mine))
    changes.push({
      step: "create-label",
      command: [
        "label",
        "create",
        mine,
        "--repo",
        repository,
        "--color",
        claimPolicy.labelColours.agent,
        "--description",
        `Claimed by agent ${agent}`,
      ],
    });
  changes.push({
    step: "labels",
    command: [
      "issue",
      "edit",
      String(number),
      "--repo",
      repository,
      "--add-label",
      mine,
      ...remove.flatMap((l) => ["--remove-label", l]),
    ],
  });
  // Always post the claim comment for a new acquisition.
  changes.push({
    step: "comment",
    command: [
      "issue",
      "comment",
      String(number),
      "--repo",
      repository,
      "--body",
      `Claimed by \`${agent}\`${branch ? ` on branch \`${branch}\`` : ""} with \`github-triage claim\`. Removed: ${remove.map((l) => `\`${l}\``).join(", ")}.\n\n${op}`,
    ],
  });
  return { ok: true, noop: false, facts, changes, recheck: { agent } };
}

/**
 * Plan `needs-human N --agent NAME --designer NAME --why TEXT --question TEXT...`.
 * @returns {Promise<ClaimPlan>}
 */
export async function planNeedsHuman(repository, request, query = ghQuery) {
  const { number, agent, designer, why, questions } = request;
  const { item, repoLabels } = await readTicket(repository, number, agent, query, designer);
  const triage = `github-triage --repo ${repository}`;
  if (!item)
    return refuse("TICKET_NOT_FOUND", { number }, `#${number} must exist.`, [`${triage} --json`]);
  if (item.__typename !== "Issue")
    return refuse(
      "NOT_AN_ISSUE",
      { number, url: item.url },
      "Questions are recorded on the issue the pull request addresses.",
      [`gh pr view ${number} --repo ${repository}`],
    );
  const facts = {
    number,
    url: item.url,
    title: item.title,
    state: item.state,
    labels: item.labels.nodes.map((l) => l.name),
    owners: owners(item),
  };
  if (item.state !== "OPEN")
    return refuse("TICKET_CLOSED", facts, "Questions are recorded on open tickets.", [
      `gh issue reopen ${number} --repo ${repository}   # manual, only if it should be open`,
    ]);
  if (item.labels.pageInfo?.hasNextPage)
    return refuse(
      "EVIDENCE_INCOMPLETE",
      facts,
      "More than 100 labels; the caller's claim and readiness cannot be verified, so nothing is posted.",
      [`${triage} --issue ${number}`],
    );
  const mine = claimPolicy.owner(agent);
  const op = marker("needs-human", [repository, number, agent, designer, why, questions]);
  const already = item.comments.nodes.some((c) => c.body.includes(op));
  const readiness = workflow.readiness.filter((l) => label(item, l));
  const swap = claimPolicy.pickable.filter((l) => label(item, l));
  // Exactly one readiness label: replace ready/incomplete with needs-design; add it when there
  // is none; leave another deliberate state (blocked, parked) alone and report it.
  const held = claimPolicy.held.filter((l) => label(item, l));
  // Never add a second readiness state on top of a deliberate blocked/parked one.
  const addNeedsDesign =
    !label(item, claimPolicy.needsDesign) && !held.length && (swap.length || !readiness.length);
  const attention = claimPolicy.attention(designer);
  const add = [
    claimPolicy.question,
    claimPolicy.decisionNeeded,
    attention,
    ...(addNeedsDesign ? [claimPolicy.needsDesign] : []),
  ].filter((l) => !label(item, l));
  const remove = [...swap, ...(label(item, mine) ? [mine] : [])];
  const notes = [];
  if (held.length)
    notes.push(`Readiness ${held.join(", ")} kept; not replaced with ${claimPolicy.needsDesign}.`);
  const changes = [];
  if (!already)
    changes.push({
      step: "comment",
      command: [
        "issue",
        "comment",
        String(number),
        "--repo",
        repository,
        "--body",
        [
          claimPolicy.questionsHeading,
          "",
          `Designer: \`${designer}\` · Raised by: \`${agent}\``,
          "",
          `**Why:** ${why}`,
          "",
          ...questions.map((q, i) => `${i + 1}. ${q}`),
          "",
          op,
        ].join("\n"),
      ],
    });
  for (const name of add.filter((l) => !repoLabels.has(l)))
    changes.push({
      step: "create-label",
      command: [
        "label",
        "create",
        name,
        "--repo",
        repository,
        "--color",
        claimPolicy.labelColours[name] ?? "ededed",
      ],
    });
  if (add.length || remove.length)
    changes.push({
      step: "labels",
      command: [
        "issue",
        "edit",
        String(number),
        "--repo",
        repository,
        ...add.flatMap((l) => ["--add-label", l]),
        ...remove.flatMap((l) => ["--remove-label", l]),
      ],
    });
  return { ok: true, noop: !changes.length, facts, changes, notes };
}

/**
 * Apply a plan step by step. The comment comes first for needs-human, so a failed comment
 * leaves nothing changed. After a claim, ownership is re-read and conflicts are reported.
 * Exit: 0 done, 2 partly done or conflict, 1 nothing done.
 * @returns {Promise<ClaimResult>}
 */
export async function applyPlan(repository, plan, { run = ghRun, query = ghQuery } = {}) {
  if (!plan.ok) return { ...plan, exitCode: 1 };
  const steps = plan.changes.map((c) => ({ ...c, status: "pending" }));
  let failed = false;
  for (const step of steps) {
    if (failed) {
      step.status = "skipped";
      continue;
    }
    try {
      await run(step.command);
      step.status = "done";
    } catch (error) {
      step.status = "failed";
      step.reason = error.message;
      failed = true;
    }
  }
  const done = steps.filter((s) => s.status === "done").length;
  let conflict = null;
  if (!failed && plan.recheck && done) {
    try {
      const mine = claimPolicy.owner(plan.recheck.agent);
      const { item, claims } = await readTicket(
        repository,
        plan.facts.number,
        plan.recheck.agent,
        query,
      );
      const others = item ? owners(item).filter((o) => o !== mine) : [];
      const elsewhere = claims.filter((c) => c.number !== plan.facts.number);
      // GitHub label edits are not a lock: report conflicts rather than resolve them.
      const problems = [];
      // An incomplete label page cannot confirm ownership: a competing claim may be unseen.
      if (item?.labels?.pageInfo?.hasNextPage)
        problems.push(
          `ownership is unverified: #${plan.facts.number} has more than 100 labels, so a competing claim may be unseen`,
        );
      if (!item || item.state !== "OPEN" || !owners(item).includes(mine))
        problems.push(
          `the claim is no longer recorded on #${plan.facts.number} (open, labelled ${mine})`,
        );
      if (others.length) problems.push(`another claim appeared concurrently: ${others.join(", ")}`);
      if (elsewhere.length)
        problems.push(
          `${plan.recheck.agent} now also claims ${elsewhere.map((c) => `#${c.number}`).join(", ")}; one active claim per agent`,
        );
      if (problems.length)
        conflict = `${problems.join("; ")}. Coordinate on the tickets; nothing was removed.`;
    } catch (error) {
      // Keep the completed writes; ownership is merely unverified.
      conflict = `Writes completed, but ownership could not be re-checked (${error.message}). Re-run the claim to verify.`;
    }
  }
  const exitCode = failed ? (done ? 2 : 1) : conflict ? 2 : 0;
  return { ...plan, steps, conflict, exitCode };
}

/** POSIX shell quoting for displayed commands: nothing inside single quotes is expanded. */
export const shellQuote = (arg) =>
  /^[\w@%+=:,./-]+$/.test(arg) ? arg : `'${arg.replaceAll("'", `'\\''`)}'`;

/** Text rendering for plans, refusals and results. */
export function claimText(result, dryRun = false) {
  if (!result.ok)
    return (
      [
        `REFUSED ${result.error}: ${result.prerequisite}`,
        `Ticket: ${result.facts.url ?? `#${result.facts.number}`}`,
        ...(result.facts.owners?.length ? [`Owners: ${result.facts.owners.join(", ")}`] : []),
        ...(result.facts.activeClaims ?? []).map((c) => `Active claim: ${c.url}`),
        ...(result.facts.openBlockers ?? []).map((b) => `Open blocker: ${b}`),
        ...(result.facts.pullRequests ?? []).map((p) => `Open PR: ${p}`),
        ...(result.recovery.length ? ["Recovery:", ...result.recovery.map((r) => `  ${r}`)] : []),
      ].join("\n") + "\n"
    );
  const lines = [`${result.facts.url} ${result.facts.title}`];
  if (result.noop) lines.push(result.reason ?? "Nothing to change.");
  if (dryRun) lines.push("DRY RUN: no changes made.");
  for (const c of result.steps ?? result.changes)
    lines.push(
      `- ${c.step}${c.status ? `: ${c.status}` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
      ...(dryRun ? [`    gh ${c.command.map(shellQuote).join(" ")}`] : []),
    );
  for (const n of result.notes ?? []) lines.push(`Note: ${n}`);
  if (result.conflict) lines.push(`CONFLICT: ${result.conflict}`);
  return lines.join("\n") + "\n";
}
