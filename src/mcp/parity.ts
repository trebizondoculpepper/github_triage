/**
 * CLI/MCP parity under the response budget (#266, doc/design/mcp-bounded-results.md).
 *
 * The bounded MCP result carries CLI report fields under their CLI names. The budget may only
 * shorten lists, and `presentation.omitted` names each shortened list by its path in `data`
 * (for example `role.sections[0].items`). Parity therefore means: every shortened list is an
 * exact prefix of the CLI list with the reported omission count, and once those lists (and their
 * container's `omitted` counter) are restored from the CLI, the field is deeply equal.
 */

type Part = string | number;

/** Parse a presentation path such as `role.sections[0].items`. */
export function parsePath(path: string): Part[] {
  return [...path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((match) =>
    match[2] === undefined ? (match[1] ?? "") : Number(match[2]),
  );
}

function at(root: unknown, path: Part[]): unknown {
  let value = root;
  for (const part of path) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Record<Part, unknown>)[part];
  }
  return value;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Compare one carried field. Returns null when it matches the CLI under the rules above, or a
 * description of the first difference.
 */
export function parityDifference(
  key: string,
  mcp: unknown,
  cli: unknown,
  omitted: Record<string, number>,
): string | null {
  const restored: unknown = mcp === undefined ? undefined : JSON.parse(JSON.stringify(mcp));
  for (const [path, count] of Object.entries(omitted)) {
    const parts = parsePath(path);
    if (parts[0] !== key) continue;
    const inner = parts.slice(1);
    const ours = at(restored, inner);
    const theirs = at(cli, inner);
    if (!Array.isArray(ours) || !Array.isArray(theirs))
      return `${path}: shortened list missing on one side`;
    if (!same(ours, theirs.slice(0, ours.length))) return `${path}: not a prefix of the CLI list`;
    if (theirs.length - ours.length !== count)
      return `${path}: omitted ${count}, but the CLI has ${theirs.length - ours.length} more`;
    if (!inner.length) return null; // The whole field is the shortened list, already checked.
    // Restore the CLI list and its container counter, then require exact equality.
    const parent = at(restored, inner.slice(0, -1)) as Record<Part, unknown>;
    const cliParent = at(cli, inner.slice(0, -1)) as Record<Part, unknown>;
    parent[inner.at(-1) as Part] = theirs;
    if (typeof cliParent?.omitted === "number") parent.omitted = cliParent.omitted;
  }
  return same(restored, cli) ? null : `${key}: differs from the CLI`;
}
