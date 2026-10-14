import { isStale } from "./claims.js";
import type { GitHub, Issue } from "./github.js";
import { slicesOf, stateOf } from "./machine.js";
import { storySlug, type Slugs } from "./slug.js";
import { hhmm, storyBranch } from "./text.js";

interface Row {
  number: number;
  title: string;
  state: string;
  mode: "afk" | "hil" | null;
  blockedBy: number[];
  needsHuman: boolean;
  heldSince: string | null;
  stale: boolean;
}

/** Read-only overview. Makes no changes. */
export async function status(ctx: { github: GitHub; slugs: Slugs }, n: number, now: Date, staleAfterMs: number) {
  const { github } = ctx;
  const story = await github.getIssue(n);
  const slices = await slicesOf(github, n);
  const rows: Row[] = [];
  for (const s of slices) rows.push(await row(github, s, now, staleAfterMs));
  const head = await row(github, story, now, staleAfterMs);
  const data = {
    story: { ...head, owner: story.assignees[0] ?? null, branch: storyBranch(n, await storySlug(ctx, story)) },
    slices: rows,
  };

  const describe = (r: Row) => {
    const parts = [r.state === "blocked" && r.blockedBy.length ? `blocked by ${r.blockedBy.map((b) => `#${b}`).join(", ")}` : r.state];
    if (r.mode && r.state !== "merged" && r.state !== "closed") parts.push(`mode:${r.mode}`);
    if (r.needsHuman) parts.push("needs-human");
    if (r.heldSince) parts.push(`held since ${hhmm(r.heldSince)}${r.stale ? " (stale)" : ""}`);
    return parts.join(" · ");
  };
  const lines = [
    `Story #${n} "${story.title}": ${describe(head)} · owner ${data.story.owner ? `@${data.story.owner}` : "none"} · branch ${data.story.branch}`,
  ];
  if (rows.length) {
    lines.push(`Slices (${rows.filter((r) => r.state === "merged").length} of ${rows.length} merged):`);
    const names = rows.map((r) => `#${r.number} "${r.title}"`);
    const width = Math.max(...names.map((x) => x.length)) + 3;
    rows.forEach((r, i) => lines.push(`  ${names[i].padEnd(width)}${describe(r)}`));
  } else lines.push("No slices yet.");
  return { lines, data };
}

async function row(github: GitHub, issue: Issue, now: Date, staleAfterMs: number): Promise<Row> {
  const closed = issue.state === "closed";
  const claim = closed ? null : await github.readClaim(issue.number);
  const blockers = closed ? [] : await github.blockedBy(issue.number);
  return {
    number: issue.number,
    title: issue.title,
    state: closed ? (issue.stateReason === "not_planned" ? "closed" : "merged") : (stateOf(issue) ?? "untriaged"),
    mode: issue.labels.includes("mode:hil") ? "hil" : issue.labels.includes("mode:afk") ? "afk" : null,
    blockedBy: blockers.filter((b) => b.state === "open").map((b) => b.number),
    needsHuman: issue.labels.includes("needs-human"),
    heldSince: claim?.since ?? null,
    stale: claim ? isStale(claim, now, staleAfterMs) : false,
  };
}
