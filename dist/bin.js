#!/usr/bin/env node

// packages/cli/src/bin.ts
import { randomBytes as randomBytes2 } from "node:crypto";
import { hostname } from "node:os";

// packages/cli/src/args.ts
var BOOLEAN = /* @__PURE__ */ new Set(["json", "takeover", "dry-run", "no-open"]);
function parseArgs(argv) {
  const out = { positionals: [], flags: {}, bools: /* @__PURE__ */ new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const [name, inline] = a.slice(2).split("=", 2);
      if (BOOLEAN.has(name)) {
        out.bools.add(name);
        continue;
      }
      const value = inline ?? argv[++i];
      if (value === void 0) continue;
      out.flags[name] ??= [];
      out.flags[name].push(value);
    } else out.positionals.push(a);
  }
  return out;
}

// packages/core/src/location.ts
import { join } from "node:path";

// packages/core/src/machine.ts
var STATES = [
  "needs-refinement",
  "needs-clarification",
  "needs-plan",
  "needs-slicing",
  "blocked",
  "ready-for-agent",
  "implementation",
  "needs-review",
  "changes-requested",
  "needs-qa",
  "needs-human-qa",
  "qa-failed",
  "merge-queue"
];
var FLAGS = ["type:story", "type:slice", "in-progress", "needs-human", "mode:afk", "mode:hil"];
var FIX_STATES = ["changes-requested", "qa-failed"];
function stateOf(issue2) {
  return STATES.find((s) => issue2.labels.includes(s)) ?? null;
}
function statesOf(issue2) {
  return STATES.filter((s) => issue2.labels.includes(s));
}
function hasAmbiguousState(issue2) {
  return statesOf(issue2).length > 1;
}
function kindOf(issue2) {
  if (issue2.labels.includes("type:slice")) return "slice";
  if (issue2.labels.includes("type:story")) return "story";
  return "new";
}
async function slicesOf(github, story2) {
  return (await github.subIssues(story2)).filter((i) => kindOf(i) === "slice");
}
function stepFor(issue2) {
  if (hasAmbiguousState(issue2)) return null;
  const kind = kindOf(issue2);
  const state = stateOf(issue2);
  const hil = kind === "story" || issue2.labels.includes("mode:hil");
  if (issue2.labels.includes("needs-human") && state) {
    return {
      name: "resolving needs-human",
      skill: "norn-resolve",
      attended: true,
      outcomes: { "": { to: state, means: `clears needs-human, stays in ${state}` } }
    };
  }
  if (kind !== "new" && state === "needs-review") {
    return {
      name: "review",
      skill: "norn-review",
      attended: false,
      outcomes: {
        approve: { to: "needs-qa", means: "no requests, moves on to QA by an agent" },
        "request-changes": { to: "changes-requested", means: "put the requests in the note", note: "requests" }
      }
    };
  }
  if (kind !== "new" && state === "needs-qa") {
    return {
      name: "agent QA",
      skill: "norn-auto-qa",
      attended: false,
      evidence: true,
      outcomes: {
        pass: hil ? {
          to: "needs-human-qa",
          means: "every criterion you could check passed; moves on to QA by a person",
          note: "evidence",
          notify: kind === "story" ? "story" : "mode:hil"
        } : { to: "merge-queue", means: "every criterion passed, moves to the merge queue", note: "evidence" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "evidence" }
      }
    };
  }
  if (kind !== "new" && state === "needs-human-qa") {
    return {
      name: "human QA",
      skill: "norn-qa",
      attended: true,
      evidence: true,
      outcomes: {
        pass: { to: "merge-queue", means: "the person passes QA, moves to the merge queue" },
        fail: { to: "qa-failed", means: "put the failures with their repros in the note", note: "problems" }
      }
    };
  }
  if (kind === "story" && (state === "changes-requested" || state === "qa-failed")) {
    return {
      name: "fixing",
      skill: "norn-implement",
      attended: false,
      outcomes: { "": { to: "needs-review", means: "fixes committed on the story branch, back to review" } }
    };
  }
  if (kind === "new") {
    return {
      name: "triage",
      skill: "norn-triage",
      attended: true,
      outcomes: {
        accept: { to: "needs-refinement", means: "accepted, moves to refinement" },
        reject: { to: "not-planned", means: "closed as not planned; give the reason", note: "reason" }
      }
    };
  }
  if (kind === "story") {
    const phase1 = {
      "needs-refinement": {
        name: "refinement",
        skill: "norn-refine",
        attended: true,
        outcomes: {
          clear: { to: "needs-plan", means: "no open questions, moves on to planning" },
          questions: { to: "needs-clarification", means: "open questions, moves to clarification" }
        }
      },
      "needs-clarification": {
        name: "clarification",
        skill: "norn-clarify",
        attended: true,
        outcomes: {
          answered: { to: "needs-plan", means: "all questions answered, moves on to planning" },
          questions: { to: "needs-clarification", means: "questions remain, stays in clarification" }
        }
      },
      "needs-plan": {
        name: "planning",
        skill: "norn-plan",
        attended: true,
        outcomes: { "": { to: "needs-slicing", means: "plan is in the spec, moves on to slicing" } }
      },
      "needs-slicing": {
        name: "slicing",
        skill: "norn-slice",
        attended: true,
        outcomes: { "": { to: "implementation", means: "slices created, moves on to implementation" } }
      }
    };
    if (state && phase1[state]) return phase1[state];
  }
  if (kind === "slice" && state === "merge-queue") {
    return {
      name: "merge",
      skill: "norn-merge",
      attended: false,
      outcomes: { "": { to: "closed", means: "slice PR merged into the story branch" } }
    };
  }
  if (kind === "slice" && (state === "ready-for-agent" || state === "implementation" || state === "changes-requested" || state === "qa-failed")) {
    return {
      name: "implementation",
      skill: "norn-implement",
      attended: false,
      enterAs: "implementation",
      outcomes: { "": { to: "needs-review", means: "implementation done, PR open" } }
    };
  }
  return null;
}

// packages/core/src/text.ts
function slugify(title) {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 50).replace(/-+$/, "");
}
function specDir(n, slug) {
  return `.agents/specs/${n}-${slug}`;
}
function specPath(n, slug) {
  return `${specDir(n, slug)}/spec.md`;
}
function sh(word) {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}
function storyBranch(story2, slug) {
  return `${story2}-${slug}`;
}
function sliceBranch(story2, slug, slice) {
  return `${storyBranch(story2, slug)}-${slice}`;
}
function worktreePath(branch) {
  return `.agents/worktrees/${branch}`;
}

// packages/core/src/slug.ts
var SLUG_MARK = "norn: slug ";
async function recorded(ctx, n) {
  if (ctx.slugs.has(n)) return ctx.slugs.get(n);
  const slug = recordedSlug(await ctx.github.listComments(n));
  ctx.slugs.set(n, slug);
  return slug;
}
function recordedSlug(comments) {
  let slug = null;
  for (const body of comments) {
    const line = body.split("\n").find((l) => l.startsWith(SLUG_MARK) || l === SLUG_MARK.trimEnd());
    if (line !== void 0) slug = line.slice(SLUG_MARK.length).trim();
  }
  return slug;
}
async function storySlug(ctx, story2) {
  return await recorded(ctx, story2.number) ?? slugify(story2.title);
}
async function slugLine(ctx, story2) {
  if (await recorded(ctx, story2.number) !== null) return null;
  const slug = slugify(story2.title);
  ctx.slugs.set(story2.number, slug);
  return `${SLUG_MARK}${slug}`;
}

// packages/core/src/location.ts
async function locate(issue2, ctx) {
  if (kindOf(issue2) === "story") {
    const slug = await storySlug(ctx, issue2);
    const branch = storyBranch(issue2.number, slug);
    return { branch, base: ctx.config.baseBranch, worktree: worktreePath(branch), story: issue2, slug };
  }
  if (kindOf(issue2) === "slice") {
    const parent = await ctx.github.parentOf(issue2.number);
    if (!parent) return null;
    const story2 = await ctx.github.getIssue(parent);
    const slug = await storySlug(ctx, story2);
    const branch = sliceBranch(story2.number, slug, issue2.number);
    return { branch, base: storyBranch(story2.number, slug), worktree: worktreePath(branch), story: story2, slug };
  }
  return null;
}
async function branchAt(loc, workspace, github) {
  return { local: await workspace.localBranchExists(loc.branch), remote: await github.branchExists(loc.branch) };
}
function createWorktreeCommand(provider, loc, absRoot, at) {
  const root = sh(absRoot);
  const path = sh(join(absRoot, loc.worktree));
  const git = `git -C ${root}`;
  const branch = sh(loc.branch);
  const base = sh(loc.base);
  const herdr = (extra) => `herdr worktree create --cwd ${root} --branch ${branch}${extra} --path ${path} --no-focus`;
  const add = provider === "herdr" ? herdr("") : `${git} worktree add ${path} ${branch}`;
  if (at.local) return at.remote ? `${git} fetch origin ${branch} && ${add} && git -C ${path} merge --ff-only origin/${branch}` : add;
  if (at.remote) {
    return provider === "herdr" ? `${git} fetch origin ${base} ${branch} && ${herdr(` --base origin/${branch}`)}` : `${git} fetch origin ${branch} && ${add}`;
  }
  return provider === "herdr" ? `${git} fetch origin ${base} && ${git} branch --no-track ${branch} origin/${base} && ${herdr("")}` : `${git} fetch origin ${base} && ${git} worktree add --no-track ${path} -b ${branch} origin/${base}`;
}
function detectProvider(env) {
  if (env.HERDR_ENV === "1") return "herdr";
  if (env.CLAUDECODE === "1") return "claude-code";
  return "git";
}
async function workIn(loc, workspace, github, provider) {
  const where = { path: join(workspace.root, loc.worktree), branch: loc.branch };
  if (!await workspace.worktreeExists(loc.worktree)) {
    const elsewhere = await workspace.branchCheckedOutAt(loc.branch);
    if (elsewhere) return { ...where, worktree: { kind: "checked-out-elsewhere", at: elsewhere } };
    const at = await branchAt(loc, workspace, github);
    return { ...where, worktree: { kind: "missing", create: createWorktreeCommand(provider, loc, workspace.root, at) } };
  }
  const dirty = await workspace.worktreeDirty(loc.worktree);
  const update = await github.branchExists(loc.branch) ? updateWorktreeCommand(loc, workspace.root) : null;
  return { ...where, worktree: { kind: "exists", dirty, update } };
}
function updateWorktreeCommand(loc, absRoot) {
  const wt = `git -C ${sh(join(absRoot, loc.worktree))}`;
  return `${wt} fetch origin ${sh(loc.branch)} && ${wt} merge --ff-only origin/${sh(loc.branch)}`;
}

// packages/core/src/claims.ts
async function acquire(github, n, record, now, staleAfterMs, opts = {}) {
  if (await github.createClaim(n, record)) return { ok: true };
  const held = await github.readClaim(n);
  if (!held) return lost(github, n, record);
  if (held.session === record.session) {
    if (await github.replaceClaim(n, held.sha, record)) return { ok: true, reacquired: true };
    return lost(github, n, record);
  }
  const stale = isStale(held, now, staleAfterMs);
  if (stale || opts.takeover && held.holder === record.holder) {
    const { sha: _sha, ...was } = held;
    if (await github.replaceClaim(n, held.sha, record)) return stale ? { ok: true, tookOver: was } : { ok: true, tookOver: was, ownTakeover: true };
    return lost(github, n, record);
  }
  return { ok: false, held: strip(held) };
}
async function lost(github, n, record) {
  const now = await github.readClaim(n);
  if (now) return { ok: false, held: strip(now) };
  return await github.createClaim(n, record) ? { ok: true } : { ok: false, held: strip(await github.readClaim(n)) };
}
function strip(claim) {
  if (!claim) return null;
  const { sha: _sha, ...record } = claim;
  return record;
}
function isStale(claim, now, staleAfterMs) {
  return now.getTime() - new Date(claim.since).getTime() > staleAfterMs;
}

// packages/core/src/notify.ts
async function send(ctx, notification) {
  if (!ctx.config.notifications) return;
  try {
    await ctx.notify(ctx.config.notifications, notification);
  } catch {
  }
}
async function notifyNeedsHuman(ctx, n, reason) {
  await send(ctx, { kind: "needs-human", issue: n, reason, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}
async function notifyHumanQa(ctx, n, of) {
  await send(ctx, { kind: "needs-human-qa", issue: n, of, url: `${await ctx.github.repoUrl()}/issues/${n}` });
}

// packages/core/src/transitions.ts
var NEEDS_HUMAN_MARK = "norn: needs-human \u2014 ";
function needsHumanLine(reason) {
  return `${NEEDS_HUMAN_MARK}${oneLine(reason)}`;
}
function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}
async function needsHumanReason(github, n) {
  return lastNeedsHumanReason(await github.listComments(n));
}
function lastNeedsHumanReason(comments) {
  for (const body of [...comments].reverse()) {
    const reason = needsHumanIn(body);
    if (reason !== null) return reason;
  }
  return null;
}
function needsHumanIn(body) {
  const line = body.split("\n").find((l) => l.startsWith(NEEDS_HUMAN_MARK));
  return line === void 0 ? null : line.slice(NEEDS_HUMAN_MARK.length);
}
function isNornComment(body) {
  return body.startsWith("norn: ");
}
function fixLimitReason(max) {
  return `(${max} fix rounds reached)`;
}
var FIX_LIMIT = new RegExp(`^${NEEDS_HUMAN_MARK}.*\\(\\d+ fix rounds reached\\)$`, "m");
var TRANSITION = /^norn: (\S+) → (\S+)/;
function fixRounds(comments) {
  let rounds = 0;
  for (const body of comments) {
    if (FIX_LIMIT.test(body)) {
      rounds = 0;
      continue;
    }
    const m = TRANSITION.exec(body);
    if (m && m[1] !== m[2] && FIX_STATES.includes(m[2])) rounds++;
  }
  return rounds;
}
var IMAGE = /\.(png|jpe?g|gif|webp|svg)$/i;
var EVIDENCE_HEAD = /^Evidence \((\S+) at (\S+)\):$/;
var EVIDENCE_FILE = /^(?:!\[(.*)\]\((\S+?)\?raw=true\)|- \[(.*)\]\((\S+)\))$/;
function parseTransitionComment(body) {
  const lines = body.split("\n");
  const head = /^norn: (\S+) → (closed as not planned|\S+)(?: \((.+)\))?$/.exec(lines[0]);
  if (!head) return null;
  let rest = lines.slice(1);
  const needsHuman = needsHumanIn(body);
  if (needsHuman !== null) rest = rest.filter((l) => !l.startsWith(NEEDS_HUMAN_MARK));
  for (const marker of ["Spec: ", SLUG_MARK]) {
    if (rest[0] === "" && rest[1]?.startsWith(marker)) rest = rest.slice(2);
  }
  let evidence = null;
  let at = rest.length - 1;
  while (at >= 0 && !EVIDENCE_HEAD.test(rest[at])) at--;
  if (at >= 0 && rest.slice(at + 1).every((l) => l === "" || EVIDENCE_FILE.test(l))) {
    const [, branch] = EVIDENCE_HEAD.exec(rest[at]);
    const files2 = [];
    let sha = "";
    for (const l of rest.slice(at + 1)) {
      const m = EVIDENCE_FILE.exec(l);
      if (!m) continue;
      files2.push(m[1] ?? m[3]);
      sha ||= /\/blob\/([^/]+)\//.exec(m[2] ?? m[4])?.[1] ?? "";
    }
    evidence = { branch, sha: sha || EVIDENCE_HEAD.exec(rest[at])[2], files: files2 };
    rest = rest.slice(0, at);
  }
  const note = rest.join("\n").trim();
  return { from: head[1], to: head[2], why: head[3] ?? null, note: note || null, evidence, needsHuman };
}
function evidenceLines(repoUrl, e) {
  const lines = [`Evidence (${e.branch} at ${e.sha.slice(0, 7)}):`, ""];
  for (const f of e.files) {
    const url = `${repoUrl}/blob/${e.sha}/${f.split("/").map(encodeURIComponent).join("/")}`;
    lines.push(IMAGE.test(f) ? `![${f}](${url}?raw=true)` : `- [${f}](${url})`);
  }
  return lines;
}
async function applyOutcome(ctx, issue2, outcome, word, note, evidence) {
  const { github } = ctx;
  const n = issue2.number;
  const from = stateOf(issue2) ?? "triage";
  const resolved = !word && issue2.labels.includes("needs-human") && !outcome.needsHuman;
  const why = word || (resolved ? "needs-human resolved" : "");
  const comment = [`norn: ${from} \u2192 ${outcome.to === "not-planned" ? "closed as not planned" : outcome.to}${why ? ` (${why})` : ""}`];
  const spec = await specLink(ctx, issue2);
  if (spec) comment.push("", `Spec: ${spec}`);
  const becomesStory = kindOf(issue2) === "story" || kindOf(issue2) === "new" && outcome.to !== "not-planned";
  const slug = becomesStory ? await slugLine(ctx, issue2) : null;
  if (slug) comment.push("", slug);
  if (note) comment.push("", note);
  if (evidence) comment.push("", ...evidenceLines(await github.repoUrl(), evidence));
  if (outcome.to === "not-planned" || outcome.to === "closed") {
    await github.comment(n, comment.join("\n"));
    await github.closeIssue(n, outcome.to === "closed" ? "completed" : "not_planned");
    await github.removeLabels(n, ["in-progress", "needs-human", ...stateLabels(issue2)]);
  } else {
    const add = [outcome.to];
    if (kindOf(issue2) === "new") {
      add.push("type:story");
      await github.assign(n, [await github.currentUser()]);
    }
    if (outcome.needsHuman) {
      add.push("needs-human");
      comment.push("", needsHumanLine(outcome.needsHuman));
    }
    const remove = ["in-progress", ...outcome.needsHuman ? [] : ["needs-human"], ...stateLabels(issue2, outcome.to)];
    await github.addLabels(n, add);
    await github.comment(n, comment.join("\n"));
    await github.removeLabels(n, remove);
    if (outcome.needsHuman) await notifyNeedsHuman(ctx, n, outcome.needsHuman);
    else if (outcome.notify) await notifyHumanQa(ctx, n, outcome.notify);
  }
}
async function followUps(ctx, issue2, outcome) {
  if (kindOf(issue2) !== "slice" || outcome.to !== "closed") return [];
  const story2 = await ctx.github.parentOf(issue2.number);
  if (!story2) return [];
  const events = [];
  const loc = await locate(issue2, ctx);
  if (loc && await ctx.workspace.worktreeExists(loc.worktree)) events.push({ kind: "worktree-left-for-tidy", worktree: loc.worktree });
  events.push(...await bestEffort("unblock-slices", story2, story2, () => syncBlocked(ctx, story2)));
  events.push(...await bestEffort("move-story-on", story2, story2, () => promoteStory(ctx, story2)));
  return events;
}
async function bestEffort(what, issue2, retry, fn) {
  try {
    return await fn();
  } catch (e) {
    return [{ kind: "follow-up-failed", what, issue: issue2, retry, detail: e.message }];
  }
}
async function ensureStoryBranch(ctx, story2) {
  const branch = storyBranch(story2.number, await storySlug(ctx, story2));
  if (await ctx.github.branchExists(branch)) return { ok: true, created: false, branch };
  const base = ctx.config.baseBranch;
  if (!await ctx.github.branchExists(base)) return { ok: false, refusal: { kind: "base-branch-missing", branch, base } };
  await ctx.github.createBranch(branch, base);
  return { ok: true, created: true, branch };
}
async function specLink(ctx, issue2) {
  let story2 = kindOf(issue2) === "story" ? issue2 : null;
  if (kindOf(issue2) === "slice") {
    const p = await ctx.github.parentOf(issue2.number);
    if (p) story2 = await ctx.github.getIssue(p);
  }
  if (!story2) return null;
  const slug = await storySlug(ctx, story2);
  return `${await ctx.github.repoUrl()}/blob/${storyBranch(story2.number, slug)}/${specPath(story2.number, slug)}`;
}
async function withShortClaim(ctx, n, fn) {
  const user = await ctx.github.currentUser();
  const got = await acquire(ctx.github, n, { holder: user, session: ctx.session, since: ctx.now().toISOString() }, ctx.now(), ctx.config.staleAfterMs);
  if (!got.ok) return false;
  try {
    await fn();
  } finally {
    if (!got.reacquired) await ctx.github.deleteClaim(n);
  }
  return true;
}
async function setState(ctx, issue2, to, why) {
  const from = stateOf(issue2);
  const slug = kindOf(issue2) === "story" ? await slugLine(ctx, issue2) : null;
  await ctx.github.addLabels(issue2.number, [to]);
  await ctx.github.comment(issue2.number, `norn: ${from} \u2192 ${to} (automatic)

${why}${slug ? `

${slug}` : ""}`);
  await ctx.github.removeLabels(issue2.number, stateLabels(issue2, to));
}
function stateLabels(issue2, keep) {
  return STATES.filter((s) => s !== keep && issue2.labels.includes(s));
}
async function closeMergedStory(ctx, story2) {
  if (story2.state !== "open" || stateOf(story2) !== "merge-queue") return false;
  const branch = storyBranch(story2.number, await storySlug(ctx, story2));
  const pr = await ctx.github.findPullRequest(branch);
  if (pr?.state !== "merged") return false;
  return withShortClaim(ctx, story2.number, async () => {
    await ctx.github.comment(story2.number, `norn: merge-queue \u2192 closed (automatic)

The story PR #${pr.number} is merged into ${pr.base}.`);
    await ctx.github.closeIssue(story2.number, "completed");
    await ctx.github.removeLabels(story2.number, ["in-progress", ...stateLabels(story2)]);
  });
}
async function clearClosedState(ctx, issue2) {
  const left = stateLabels(issue2);
  if (issue2.state !== "closed" || left.length === 0) return false;
  return withShortClaim(ctx, issue2.number, () => ctx.github.removeLabels(issue2.number, left));
}
async function syncBlocked(ctx, story2) {
  const events = [];
  for (const slice of await slicesOf(ctx.github, story2)) {
    const state = stateOf(slice);
    if (slice.state !== "open" || state !== "blocked" && state !== "ready-for-agent") continue;
    const open = (await ctx.github.blockedBy(slice.number)).filter((b) => b.state === "open");
    const want = open.length ? "blocked" : "ready-for-agent";
    if (want === state) continue;
    const why = open.length ? `Blocked by ${open.map((b) => `#${b.number}`).join(", ")}.` : "All blockers are closed.";
    if (await withShortClaim(ctx, slice.number, () => setState(ctx, slice, want, why))) {
      events.push({ kind: "slice-state-changed", issue: slice.number, state: want });
    }
  }
  return events;
}
async function promoteStory(ctx, storyNumber) {
  const { github } = ctx;
  const events = [];
  const slices = await slicesOf(github, storyNumber);
  const story2 = await github.getIssue(storyNumber);
  if (story2.state === "open" && slices.length && slices.every((s) => s.state === "closed") && stateOf(story2) === "implementation") {
    const slug = await storySlug(ctx, story2);
    const branch = storyBranch(story2.number, slug);
    const base = ctx.config.baseBranch;
    const moved = await withShortClaim(ctx, storyNumber, async () => {
      const pr = await github.findPullRequest(branch) ?? await github.createPullRequest({
        head: branch,
        base,
        title: story2.title,
        body: `Closes #${story2.number}

Spec: ${specPath(story2.number, slug)}`
      });
      await setState(ctx, story2, "needs-review", `Every slice is merged into ${branch}. Story PR: #${pr.number}.`);
    });
    if (moved) events.push({ kind: "story-promoted", story: storyNumber });
  }
  return events;
}
async function sliceMergeRefusal(ctx, slice) {
  const { github } = ctx;
  const n = slice.number;
  const storyNumber = await github.parentOf(n);
  if (!storyNumber) return { kind: "not-in-story", issue: n };
  const story2 = await github.getIssue(storyNumber);
  const slug = await storySlug(ctx, story2);
  const head = sliceBranch(story2.number, slug, n);
  const base = storyBranch(story2.number, slug);
  const pr = await github.findPullRequest(head);
  if (!pr) return { kind: "no-slice-pr", issue: n, head };
  if (pr.base !== base) return { kind: "slice-pr-wrong-base", issue: n, pr: pr.number, head, base: pr.base, storyBranch: base, merged: pr.state === "merged" };
  if (pr.state !== "merged") return { kind: "slice-pr-not-merged", issue: n, pr: pr.number, head, base: pr.base };
  return null;
}

// packages/core/src/briefing.ts
function noun(issue2) {
  const kind = kindOf(issue2);
  return kind === "new" ? "issue" : kind;
}
async function briefing(issue2, step, ctx, from) {
  const n = issue2.number;
  const loc = await locate(issue2, ctx);
  const rework = step.skill === "norn-implement" && (from !== null && FIX_STATES.includes(from) || fixRounds(await ctx.github.listComments(n)) > 0);
  return {
    issue: n,
    noun: noun(issue2),
    title: issue2.title,
    step: { name: step.name, skill: step.skill, attended: step.attended },
    workIn: loc ? await workIn(loc, ctx.workspace, ctx.github, ctx.config.provider) : null,
    instructions: processLines(issue2, step, loc, rework),
    finish: finishCommands(n, step)
  };
}
function finishCommands(n, step) {
  return Object.entries(step.outcomes).map(([word, o]) => ({
    issue: n,
    word,
    ...o.note ? { note: o.note } : {},
    evidence: step.evidence ?? false,
    means: o.means
  }));
}
function processLines(issue2, step, loc, isRework) {
  const n = issue2.number;
  const readIssue = `Read the issue: gh issue view ${n} --comments`;
  if (step.skill === "norn-triage") {
    return [readIssue, `On accept, post what triage established on the issue first: gh issue comment ${n}`];
  }
  if (!loc) return [];
  const story2 = loc.story;
  const spec = specPath(story2.number, loc.slug);
  const pushSpec = `Commit the spec on ${loc.branch} and push it, so the link norn posts resolves.`;
  const rework = isRework ? [`This is rework: the latest review or QA comment on #${n} lists what to fix. ${readIssue}`] : [];
  if (step.skill === "norn-resolve") {
    const lines2 = [`The latest needs-human comment gives the reason. ${readIssue}`, `Record the outcome on the issue: gh issue comment ${n}`];
    if (kindOf(issue2) === "story") lines2.push(`Spec changes go in ${spec}; commit and push them on ${loc.branch}.`);
    return lines2;
  }
  if (kindOf(issue2) === "story") {
    const lines2 = [`Spec to work on: ${spec}`];
    if (step.skill === "norn-refine" || step.skill === "norn-clarify") lines2.push(readIssue, pushSpec);
    if (step.skill === "norn-plan") lines2.push(pushSpec);
    if (step.skill === "norn-slice") {
      lines2.push(
        "Create the slices in dependency order, blockers first, one command per slice:",
        `  norn add-slice ${n} "title" --mode afk|hil [--blocked-by <slice>]...`,
        "  --mode afk when an agent can verify every criterion, hil when a person must also look at it.",
        "Then give each slice its body: gh issue edit <slice> --body-file <file>",
        `Push ${loc.branch} once the slices exist, so slice PRs can target it.`
      );
    }
    if (step.skill === "norn-implement") lines2.push(...rework, `Commit the fixes straight onto the story branch ${loc.branch} and push them.`);
    if (step.skill === "norn-review" || step.skill === "norn-auto-qa" || step.skill === "norn-qa") {
      lines2.push(`Story PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`);
    }
    lines2.push(...qaLines(issue2, step, loc, readIssue));
    return lines2;
  }
  const lines = [`Spec: ${spec} (story #${story2.number})`, readIssue];
  if (step.skill === "norn-implement") {
    lines.push(
      ...rework,
      `Commit on ${loc.branch} and push. Open one PR from ${loc.branch} into ${loc.base} if there is none yet:`,
      // The title is free text from GitHub: quoted, so a " or $(...) in it can neither break nor run anything.
      `  gh pr create --base ${sh(loc.base)} --head ${sh(loc.branch)} --title ${sh(issue2.title)} --body ${sh(`Part of #${story2.number}. Slice #${n}.`)}`
    );
  } else if (step.skill === "norn-merge") {
    lines.push(
      `Merge origin/${loc.base} into ${loc.branch}, resolving conflicts if needed, and push.`,
      `Then merge the PR: gh pr merge ${sh(loc.branch)} --merge`
    );
  } else {
    lines.push(`Slice PR: ${loc.branch} into ${loc.base}. Diff: git diff ${sh(`origin/${loc.base}...HEAD`)}`, ...qaLines(issue2, step, loc, readIssue));
  }
  return lines;
}
function qaLines(issue2, step, loc, readIssue) {
  const n = issue2.number;
  const files2 = "Keep screenshots, logs and command output in a directory outside the repository and finish with --evidence <dir>: norn pushes the files and embeds them in the comment. Do not commit them.";
  if (step.skill === "norn-auto-qa") {
    const lines = ["Your note is the evidence pack: one line per criterion with what you ran, what you saw and its evidence.", files2];
    if (kindOf(issue2) === "slice" && issue2.labels.includes("mode:afk")) {
      lines.push(`No person checks this slice after you. A criterion you cannot check is never passed: run norn escalate ${n} "reason".`);
    } else {
      lines.push(
        "A person QAs this after you. For what only a person can check (the slice's verifier reason), list it in the note",
        "with what you could prepare: how to run it, a URL, screenshots up to where you had to stop. Then pass."
      );
    }
    return lines;
  }
  if (step.skill === "norn-qa") {
    return [
      `Start from the agent's QA comment on #${n}: its evidence, and what it left for a person. ${readIssue}`,
      `Run the app from ${loc.branch} on this machine and walk the user through what is left, plus anything in the evidence they question.`,
      "Tie each remark the user brings to a criterion; a remark on a criterion fails it. For a remark outside the criteria, the user decides:",
      `  follow up (the default): gh issue create --title "<remark>" --body "From QA of #${n}: <remark>" (it goes through triage)`,
      "  pull it in: it fails this item, like a criterion",
      "  drop it: say so in the note",
      `Every failure needs a repro. ${files2}`
    ];
  }
  return [];
}

// packages/core/src/config.ts
var TEAM_CONFIG = ".agents/norn.config.json";
var LOCAL_CONFIG = ".agents/norn.config.local.json";
var DEFAULT_TEAM_CONFIG = {
  baseBranch: "main",
  worktrees: { provider: "auto" },
  claims: { staleAfter: "2h" },
  deliver: { maxParallel: 2, maxFixRounds: 3 }
};
var PROVIDERS = ["auto", "herdr", "claude-code", "git"];
var NOTIFICATIONS = ["auto", "herdr", "os", "none"];
var ENV_FOR = { herdr: "HERDR_ENV", "claude-code": "CLAUDECODE", git: null };
var UNITS = { s: 1e3, m: 6e4, h: 36e5, d: 864e5 };
var MIN_STALE_AFTER_MS = 10 * UNITS.m;
function toMs(duration2) {
  return Number(duration2.slice(0, -1)) * UNITS[duration2.slice(-1)];
}
function durationMs(duration2) {
  return /^\d+[smhd]$/.test(duration2) ? toMs(duration2) : null;
}
function check(file, raw) {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { problems: [{ kind: "not-an-object", file }], warnings: [] };
  const problems = [];
  const warnings = [];
  const r = raw;
  for (const key of Object.keys(r)) {
    if (!["baseBranch", "worktrees", "claims", "deliver", "notifications", "dashboard"].includes(key)) problems.push({ kind: "unknown-setting", file, key });
  }
  if ("baseBranch" in r && (typeof r.baseBranch !== "string" || !r.baseBranch)) problems.push({ kind: "bad-base-branch", file });
  const provider = r.worktrees?.provider;
  if (provider !== void 0 && !PROVIDERS.includes(provider)) {
    problems.push({ kind: "bad-provider", file, allowed: PROVIDERS });
  }
  const stale = r.claims?.staleAfter;
  if (stale !== void 0 && !/^\d+[smhd]$/.test(String(stale))) {
    problems.push({ kind: "bad-stale-after", file });
  } else if (file === TEAM_CONFIG && stale !== void 0 && toMs(stale) < MIN_STALE_AFTER_MS) {
    warnings.push({ kind: "stale-after-clamped", file, value: stale, minimum: "10m" });
  }
  if (file === LOCAL_CONFIG) {
    if (stale !== void 0) warnings.push({ kind: "team-setting-in-local-file", file, setting: "claims.staleAfter", team: TEAM_CONFIG });
    if (r.deliver?.maxFixRounds !== void 0) {
      warnings.push({ kind: "team-setting-in-local-file", file, setting: "deliver.maxFixRounds", team: TEAM_CONFIG });
    }
  }
  if ("notifications" in r) {
    if (file === TEAM_CONFIG) problems.push({ kind: "notifications-in-team-file", file, local: LOCAL_CONFIG });
    else if (!NOTIFICATIONS.includes(r.notifications)) problems.push({ kind: "bad-notifications", file, allowed: NOTIFICATIONS });
  }
  if ("dashboard" in r) {
    if (file === TEAM_CONFIG) problems.push({ kind: "dashboard-in-team-file", file, local: LOCAL_CONFIG });
    else {
      const d = r.dashboard ?? {};
      if (typeof d !== "object" || Array.isArray(d)) problems.push({ kind: "bad-dashboard-setting", file, key: "port" });
      else {
        if (d.port !== void 0 && !(Number.isInteger(d.port) && d.port > 0 && d.port < 65536)) {
          problems.push({ kind: "bad-dashboard-setting", file, key: "port" });
        }
        if (d.interval !== void 0 && (typeof d.interval !== "string" || durationMs(d.interval) === null)) {
          problems.push({ kind: "bad-dashboard-setting", file, key: "interval" });
        }
      }
    }
  }
  const deliver = r.deliver ?? {};
  for (const key of ["maxParallel", "maxFixRounds"]) {
    const v = deliver[key];
    if (v !== void 0 && !(Number.isInteger(v) && v > 0)) problems.push({ kind: "bad-deliver-number", file, key });
  }
  return { problems, warnings };
}
async function read(workspace, file) {
  const text = await workspace.readFile(file);
  if (text === null) return { raw: {}, problems: [], warnings: [] };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return { raw: {}, problems: [{ kind: "invalid-json", file, detail: e.message }], warnings: [] };
  }
  const { problems, warnings } = check(file, raw);
  return { raw: problems.length ? {} : raw, problems, warnings };
}
async function loadConfig(workspace) {
  const team = await read(workspace, TEAM_CONFIG);
  const local = await read(workspace, LOCAL_CONFIG);
  const problems = [...team.problems, ...local.problems];
  if (problems.length) return { ok: false, refusal: { kind: "config-invalid", problems } };
  const merged = {
    baseBranch: local.raw.baseBranch ?? team.raw.baseBranch ?? DEFAULT_TEAM_CONFIG.baseBranch,
    provider: local.raw.worktrees?.provider ?? team.raw.worktrees?.provider ?? "auto",
    staleAfter: team.raw.claims?.staleAfter ?? DEFAULT_TEAM_CONFIG.claims.staleAfter
  };
  const notifications = local.raw.notifications ?? "auto";
  const channel = notifications === "none" ? null : notifications === "auto" ? workspace.env.HERDR_ENV === "1" ? "herdr" : "os" : notifications;
  const provider = merged.provider === "auto" ? detectProvider(workspace.env) : merged.provider;
  return {
    ok: true,
    config: {
      baseBranch: merged.baseBranch,
      provider,
      staleAfterMs: Math.max(toMs(merged.staleAfter), MIN_STALE_AFTER_MS),
      maxParallel: local.raw.deliver?.maxParallel ?? team.raw.deliver?.maxParallel ?? DEFAULT_TEAM_CONFIG.deliver.maxParallel,
      notifications: channel,
      maxFixRounds: team.raw.deliver?.maxFixRounds ?? DEFAULT_TEAM_CONFIG.deliver.maxFixRounds,
      dashboard: {
        port: local.raw.dashboard?.port ?? null,
        intervalMs: local.raw.dashboard?.interval === void 0 ? null : durationMs(local.raw.dashboard.interval)
      }
    },
    warnings: [...team.warnings, ...local.warnings]
  };
}
function providerRefusal(config, env) {
  const variable = ENV_FOR[config.provider];
  if (!variable || env[variable] === "1") return null;
  return { kind: "provider-mismatch", provider: config.provider, variable };
}

// packages/core/src/next.ts
import { join as join2 } from "node:path";

// packages/core/src/workspace.ts
import { win32 } from "node:path";
function comparablePath(p, platform = process.platform) {
  const forward = (platform === "win32" ? win32.normalize(p) : p).replace(/\\/g, "/").replace(/\/+$/, "");
  return platform === "win32" ? forward.replace(/^[A-Z]:/, (d) => d.toLowerCase()) : forward;
}
function samePath(a, b, platform = process.platform) {
  return comparablePath(a, platform) === comparablePath(b, platform);
}
function isWithin(path, dir, platform = process.platform) {
  const p = comparablePath(path, platform);
  const d = comparablePath(dir, platform);
  return p === d || p.startsWith(`${d}/`);
}

// packages/core/src/next.ts
async function reconcile(ctx, storyNumber) {
  const { github } = ctx;
  const notes = [];
  const story2 = await github.getIssue(storyNumber);
  if (story2.state === "open" && stateOf(story2) === "implementation") {
    try {
      const branch = await ensureStoryBranch(ctx, story2);
      if (!branch.ok) notes.push(branch.refusal);
      else if (branch.created) notes.push({ kind: "story-branch-created", branch: branch.branch });
    } catch (e) {
      notes.push({ kind: "story-branch-failed", detail: e.message });
    }
  }
  notes.push(...await bestEffort("move-story-on", storyNumber, storyNumber, () => promoteStory(ctx, storyNumber)));
  notes.push(
    ...await bestEffort("close-merged-story", storyNumber, storyNumber, async () => {
      if (!await closeMergedStory(ctx, story2)) return [];
      story2.state = "closed";
      story2.labels = story2.labels.filter((l) => !STATES.includes(l));
      return [{ kind: "story-closed", story: storyNumber }];
    })
  );
  const closed = (await slicesOf(github, storyNumber)).filter((s) => s.state === "closed");
  if (story2.state === "closed") closed.push(story2);
  for (const issue2 of closed) {
    notes.push(
      ...await bestEffort("clear-labels", issue2.number, storyNumber, async () => {
        await clearClosedState(ctx, issue2);
        return [];
      })
    );
  }
  return notes;
}
async function computeNext(ctx, storyNumber) {
  const { github } = ctx;
  await syncBlocked(ctx, storyNumber);
  const notes = await reconcile(ctx, storyNumber);
  const story2 = await github.getIssue(storyNumber);
  const slices = await slicesOf(github, storyNumber);
  const report = {
    story: storyNumber,
    provider: ctx.config.provider,
    maxParallel: ctx.config.maxParallel,
    title: story2.title,
    // A closed story has no state, whatever labels GitHub left on it.
    state: story2.state === "closed" ? null : stateOf(story2),
    branch: storyBranch(storyNumber, await storySlug(ctx, story2)),
    slices: { total: slices.length, merged: slices.filter((s) => s.state === "closed").length },
    start: [],
    waiting: [],
    notes,
    nothingLeft: false,
    closed: story2.state === "closed",
    notPlanned: story2.stateReason === "not_planned",
    notified: ctx.config.notifications !== null,
    running: 0,
    slots: ctx.config.maxParallel
  };
  if (report.closed) {
    report.nothingLeft = true;
    return report;
  }
  if (stateOf(story2) === "merge-queue") {
    report.waiting.push({ issue: storyNumber, reason: "owner-merge", owner: story2.assignees[0] ?? null, into: ctx.config.baseBranch });
    report.nothingLeft = true;
    return report;
  }
  for (const issue2 of [story2, ...slices]) {
    if (issue2.state !== "open") continue;
    await classify(ctx, issue2, report);
  }
  report.nothingLeft = report.start.length === 0 && !report.waiting.some((w) => w.reason === "held");
  report.running = report.waiting.filter((w) => w.reason === "held" && w.holder.mine).length;
  report.slots = Math.max(0, ctx.config.maxParallel - report.running);
  report.notified &&= toNotify(report).length > 0 || !report.waiting.some((w) => "heldBy" in w && w.heldBy);
  return report;
}
async function classify(ctx, issue2, report) {
  const n = issue2.number;
  const state = stateOf(issue2);
  const states = statesOf(issue2);
  if (states.length > 1) {
    report.waiting.push({ issue: n, reason: "ambiguous-state", states });
    return;
  }
  if (issue2.labels.includes("needs-human")) {
    report.waiting.push({ issue: n, reason: "needs-human", why: await needsHumanReason(ctx.github, n), ...await humanWork(ctx, issue2) });
    return;
  }
  if (state === "needs-human-qa") {
    report.waiting.push({ issue: n, reason: "human-qa", of: kindOf(issue2) === "story" ? "story" : "mode:hil", ...await humanWork(ctx, issue2) });
    return;
  }
  if (!state) {
    report.waiting.push({ issue: n, reason: "no-state" });
    return;
  }
  if (state === "blocked") {
    const open = (await ctx.github.blockedBy(n)).filter((b) => b.state === "open");
    report.waiting.push({ issue: n, reason: "blocked", blockers: open.map((b) => b.number) });
    return;
  }
  const step = stepFor(issue2);
  if (!step) return;
  const held = await heldBy(ctx, n);
  if (held) {
    report.waiting.push({ issue: n, reason: "held", holder: held });
    return;
  }
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue2);
  report.start.push({
    issue: n,
    branch: loc?.branch ?? null,
    worktree,
    createWorktree,
    checkedOutAt,
    here,
    // Fresh for every agent: a new agent on an item whose claim went stale must not pass for the old holder.
    session: ctx.config.provider === "git" ? `norn-${n}-${ctx.nonce()}` : null,
    kind: kindOf(issue2) === "slice" ? "slice" : "story",
    title: issue2.title,
    state,
    step: step.name,
    skill: step.skill,
    attended: step.attended,
    command: `norn take ${n}`
  });
}
async function place(ctx, issue2) {
  const loc = await locate(issue2, ctx);
  const worktree = loc ? join2(ctx.workspace.root, loc.worktree) : null;
  const here = worktree !== null && isWithin(ctx.workspace.cwd, worktree);
  let createWorktree = null;
  let checkedOutAt = null;
  if (loc && ctx.config.provider !== "claude-code" && !await ctx.workspace.worktreeExists(loc.worktree)) {
    checkedOutAt = await ctx.workspace.branchCheckedOutAt(loc.branch);
    if (!checkedOutAt) {
      createWorktree = createWorktreeCommand(ctx.config.provider, loc, ctx.workspace.root, await branchAt(loc, ctx.workspace, ctx.github));
    }
  }
  return { loc, worktree, createWorktree, checkedOutAt, here };
}
async function heldBy(ctx, n) {
  const claim = await ctx.github.readClaim(n);
  if (!claim || isStale(claim, ctx.now(), ctx.config.staleAfterMs)) return null;
  const mine = claim.holder === await ctx.github.currentUser();
  return { session: claim.session === ctx.session ? "this" : mine ? "yours" : "other", mine, since: claim.since };
}
async function humanWork(ctx, issue2) {
  const held = await heldBy(ctx, issue2.number);
  if (held) return { heldBy: held };
  if (ctx.config.provider !== "herdr") return {};
  const { loc, worktree, createWorktree, checkedOutAt, here } = await place(ctx, issue2);
  return { branch: loc?.branch ?? null, worktree, createWorktree, checkedOutAt, here };
}
var FOR_HUMAN = ["needs-human", "human-qa", "owner-merge", "no-state", "ambiguous-state"];
async function notAStory(github, n) {
  const issue2 = await github.getIssue(n);
  if (kindOf(issue2) === "story") return null;
  if (kindOf(issue2) === "slice") return { kind: "is-a-slice", issue: n, story: await github.parentOf(n) };
  return { kind: "not-a-story", issue: n };
}
function toNotify(r) {
  return r.waiting.filter((w) => FOR_HUMAN.includes(w.reason) && !("heldBy" in w && w.heldBy));
}
async function notifyWaiting(ctx, r) {
  if (!r.notified) return;
  await send(ctx, { kind: "story-waiting", story: r.story, waiting: toNotify(r) });
}

// packages/core/src/refusals.ts
var refuse = (refusal) => ({ ok: false, refusal });

// packages/core/src/tidy.ts
import { join as join3, relative } from "node:path";
function qaBranch(n) {
  return `norn/qa/${n}`;
}
async function tidy(ctx, dryRun) {
  const { github, workspace } = ctx;
  const report = { ok: true, kind: "tidy", dryRun, removed: [], kept: [], failed: [], fetchFailed: null };
  const attempt = async (removal, fn) => {
    try {
      if (!dryRun) await fn();
      report.removed.push(removal);
      return true;
    } catch (e) {
      report.failed.push({ removal, detail: e.message });
      return false;
    }
  };
  const issues2 = /* @__PURE__ */ new Map();
  const issue2 = (n) => {
    let found = issues2.get(n);
    if (!found) {
      found = github.getIssue(n).catch(() => null);
      issues2.set(n, found);
    }
    return found;
  };
  const closed = async (n) => (await issue2(n))?.state === "closed";
  try {
    await workspace.fetchRemote();
  } catch (e) {
    report.fetchFailed = e.message;
  }
  for (const branch of await github.listBranches("norn/qa/")) {
    const n = Number(branch.slice("norn/qa/".length));
    if (Number.isInteger(n) && await closed(n)) await attempt({ kind: "qa-branch", branch, issue: n }, () => github.deleteBranch(branch));
  }
  const worktrees = await workspace.listWorktrees();
  const local = new Set(await workspace.listLocalBranches());
  const remote = new Set(await github.listBranches(""));
  const candidates = /* @__PURE__ */ new Set([...local, ...remote, ...worktrees.flatMap((w) => w.branch ? [w.branch] : [])]);
  const slices = /* @__PURE__ */ new Map();
  for (const branch of [...candidates].sort()) {
    const owned = await ownerOf(ctx, branch, issue2, slices);
    if (owned?.issue.state !== "closed") continue;
    const pr = await github.findPullRequest(branch);
    const merged = pr?.state === "merged" && pr.base === owned.into;
    const n = owned.issue.number;
    const unpushed = async () => local.has(branch) && await workspace.hasUnpushedCommits(branch) && !await mergedHead(ctx, branch, pr);
    const wtAbs = join3(workspace.root, worktreePath(branch));
    const checkedOut = worktrees.find((w) => w.branch === branch);
    let localFree = !checkedOut;
    if (checkedOut && samePath(checkedOut.path, wtAbs)) {
      const rel = relative(workspace.root, wtAbs);
      let keep = null;
      if (isWithin(workspace.cwd, wtAbs)) keep = { kind: "worktree-in-use", path: wtAbs };
      else if (await workspace.worktreeDirty(rel)) keep = { kind: "worktree-dirty", path: wtAbs };
      else if (await unpushed()) keep = { kind: "worktree-unpushed", path: wtAbs, branch };
      if (keep) {
        report.kept.push(keep);
        continue;
      }
      localFree = await attempt({ kind: "worktree", path: rel, of: kindOf(owned.issue), issue: n }, () => workspace.removeWorktree(rel, ctx.config.provider));
    } else if (checkedOut && merged && local.has(branch)) {
      report.kept.push({ kind: "branch-checked-out", branch, at: checkedOut.path });
    }
    if (!merged) continue;
    if (local.has(branch) && localFree) {
      if (await unpushed()) {
        report.kept.push({ kind: "branch-unpushed", branch });
        continue;
      }
      await attempt({ kind: "local-branch", branch, into: owned.into }, () => workspace.deleteLocalBranch(branch));
    }
    if (remote.has(branch)) await attempt({ kind: "remote-branch", branch, into: owned.into }, () => github.deleteBranch(branch));
  }
  for (const n of (await github.listClaims()).sort((a, b) => a - b)) {
    if (await closed(n)) await attempt({ kind: "claim", issue: n }, () => github.deleteClaim(n));
  }
  return report;
}
async function mergedHead(ctx, branch, pr) {
  if (pr?.state !== "merged" || !pr.headSha) return false;
  return await ctx.workspace.branchHead(branch) === pr.headSha;
}
async function ownerOf(ctx, branch, issue2, slices) {
  const m = /^(\d+)-/.exec(branch);
  if (!m) return null;
  const story2 = await issue2(Number(m[1]));
  if (!story2 || kindOf(story2) !== "story") return null;
  const own = storyBranch(story2.number, await storySlug(ctx, story2));
  if (branch === own) return { branch, issue: story2, into: ctx.config.baseBranch };
  if (!branch.startsWith(`${own}-`)) return null;
  if (!slices.has(story2.number)) slices.set(story2.number, slicesOf(ctx.github, story2.number));
  const slice = (await slices.get(story2.number)).find((s) => sliceBranch(story2.number, own.slice(`${story2.number}-`.length), s.number) === branch);
  return slice ? { branch, issue: slice, into: own } : null;
}

// packages/core/src/operations.ts
var MAX_EVIDENCE_BYTES = 25 * 1024 * 1024;
async function noStepRefusal(issue2, ctx) {
  const { github } = ctx;
  const n = issue2.number;
  if (issue2.state === "closed") return { kind: "closed", issue: n };
  const state = stateOf(issue2);
  const story2 = kindOf(issue2) === "slice" ? await github.parentOf(n) : n;
  const states = statesOf(issue2);
  if (states.length > 1) return { kind: "ambiguous-state", issue: n, states, story: story2 };
  if (kindOf(issue2) === "story" && state === "implementation") return { kind: "story-in-implementation", issue: n };
  if (kindOf(issue2) === "story" && state === "merge-queue") return { kind: "story-in-merge-queue", issue: n, owner: issue2.assignees[0] ?? null };
  if (state === "blocked") {
    const open = (await github.blockedBy(n)).filter((b) => b.state === "open");
    return { kind: "blocked", issue: n, blockers: open.map((b) => b.number), story: story2 };
  }
  return { kind: "no-step", issue: n, state, story: story2 };
}
async function take(ctx, n, opts) {
  const { github } = ctx;
  const before = await github.getIssue(n);
  if (!stepFor(before) || before.state === "closed") return refuse(await noStepRefusal(before, ctx));
  const user = await github.currentUser();
  const record = { holder: user, session: ctx.session, since: ctx.now().toISOString() };
  const claim = await acquire(github, n, record, ctx.now(), ctx.config.staleAfterMs, { takeover: opts.takeover });
  if (!claim.ok) {
    const slice = kindOf(before) === "slice";
    const since = claim.held?.since ?? null;
    if (claim.held?.holder === user) return refuse({ kind: "held-by-your-session", issue: n, slice, since });
    if (opts.takeover && claim.held) return refuse({ kind: "held-by-teammate", issue: n, slice, holder: claim.held.holder, since });
    return refuse({ kind: "held", issue: n, slice, since, story: slice ? await github.parentOf(n) : null });
  }
  const issue2 = await github.getIssue(n);
  const step = stepFor(issue2);
  if (!step) {
    await github.deleteClaim(n);
    return refuse(await noStepRefusal(issue2, ctx));
  }
  const state = stateOf(issue2);
  if (step.enterAs && step.enterAs !== state) {
    const old = stateLabels(issue2, step.enterAs);
    await github.addLabels(n, [step.enterAs, "in-progress"]);
    await github.removeLabels(n, old);
    issue2.labels = [...issue2.labels.filter((l) => !old.includes(l)), step.enterAs];
  } else {
    await github.addLabels(n, ["in-progress"]);
  }
  let tookOver = null;
  if (claim.tookOver) {
    const loc = await locate(issue2, ctx);
    const kept = loc !== null && await ctx.workspace.worktreeExists(loc.worktree);
    tookOver = { own: claim.ownTakeover ?? false, since: claim.tookOver.since, worktreeKept: kept };
  }
  return {
    ok: true,
    kind: "taken",
    issue: n,
    state: stateOf(issue2),
    step: { name: step.name, skill: step.skill, attended: step.attended, outcomes: Object.keys(step.outcomes).filter(Boolean) },
    briefing: await briefing(issue2, step, ctx, state),
    reacquired: claim.reacquired ?? false,
    tookOver
  };
}
async function checkHeld(ctx, n) {
  const claim = await ctx.github.readClaim(n);
  if (!claim) return refuse({ kind: "not-claimed", issue: n });
  if (claim.session !== ctx.session) return refuse({ kind: "held-by-other-session", issue: n, since: claim.since });
  return null;
}
async function done(ctx, n, input) {
  const { github } = ctx;
  const { word, note, evidenceDir } = input;
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  const issue2 = await github.getIssue(n);
  const step = stepFor(issue2);
  if (!step) return refuse(await noStepRefusal(issue2, ctx));
  const outcome = step.outcomes[word ?? ""];
  if (!outcome) {
    const finish = finishCommands(n, step);
    return refuse(word ? { kind: "outcome-unknown", issue: n, word, step: step.name, finish } : { kind: "outcome-missing", issue: n, step: step.name, finish });
  }
  if (outcome.note && !note) return refuse({ kind: "note-missing", issue: n, word: word ?? "", note: outcome.note, evidence: step.evidence ?? false });
  if (evidenceDir !== void 0 && !step.evidence) return refuse({ kind: "evidence-not-allowed", issue: n, step: step.name, finish: finishCommands(n, step) });
  if (kindOf(issue2) === "story" && stateOf(issue2) === "needs-slicing" && (await slicesOf(github, n)).length === 0) {
    return refuse({ kind: "no-slices", issue: n });
  }
  if (step.skill === "norn-merge") {
    const r = await sliceMergeRefusal(ctx, issue2);
    if (r) return refuse(r);
  }
  const files2 = evidenceDir === void 0 ? void 0 : await ctx.workspace.readEvidence(evidenceDir);
  if (evidenceDir !== void 0) {
    if (!files2) return refuse({ kind: "evidence-not-a-directory", dir: evidenceDir });
    if (!files2.length) return refuse({ kind: "evidence-empty", dir: evidenceDir });
    const big = files2.filter((f) => f.content.length > MAX_EVIDENCE_BYTES);
    if (big.length) return refuse({ kind: "evidence-too-big", files: big.map((f) => f.path), limitBytes: MAX_EVIDENCE_BYTES });
  }
  let storyBranchCreated = null;
  if (kindOf(issue2) === "story" && outcome.to === "implementation") {
    const branch = await ensureStoryBranch(ctx, issue2);
    if (!branch.ok) return refuse(branch.refusal);
    if (branch.created) storyBranchCreated = branch.branch;
  }
  let evidence;
  if (files2) {
    const branch = qaBranch(n);
    const sha = await github.pushFiles(branch, files2, `QA evidence for #${n} (${step.name}, ${word})`);
    evidence = { branch, sha, files: files2.map((f) => f.path) };
  }
  let applied = outcome;
  let fixLimit = null;
  if (FIX_STATES.includes(outcome.to) && stateOf(issue2) !== outcome.to) {
    const rounds = fixRounds(await github.listComments(n)) + 1;
    if (rounds > ctx.config.maxFixRounds) {
      fixLimit = ctx.config.maxFixRounds;
      applied = { ...outcome, needsHuman: `${note ? `escalated: "${oneLine(note)}" ` : ""}${fixLimitReason(fixLimit)}` };
    }
  }
  try {
    await applyOutcome(ctx, issue2, applied, word ?? "", note, evidence);
  } finally {
    await github.deleteClaim(n);
  }
  return {
    ok: true,
    kind: "done",
    issue: n,
    from: stateOf(issue2),
    to: outcome.to,
    ...evidence ? { evidence } : {},
    fixLimit,
    storyBranchCreated,
    followUps: await followUps(ctx, issue2, applied),
    deliverable: kindOf(issue2) === "story" && outcome.to === "implementation",
    personNext: !!outcome.notify && !applied.needsHuman
  };
}
async function escalate(ctx, n, reason) {
  if (!reason) return refuse({ kind: "reason-missing", issue: n });
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  const { github } = ctx;
  await github.addLabels(n, ["needs-human"]);
  await github.removeLabels(n, ["in-progress"]);
  const why = `escalated: "${oneLine(reason)}"`;
  await github.comment(n, [needsHumanLine(why), ...reason.includes("\n") ? ["", reason] : []].join("\n"));
  await notifyNeedsHuman(ctx, n, why);
  await github.deleteClaim(n);
  return { ok: true, kind: "escalated", issue: n };
}
async function release(ctx, n) {
  const notHeld = await checkHeld(ctx, n);
  if (notHeld) return notHeld;
  await ctx.github.removeLabels(n, ["in-progress"]);
  await ctx.github.deleteClaim(n);
  return { ok: true, kind: "released", issue: n };
}
async function addSlice(ctx, story2, input) {
  const { github } = ctx;
  const { title, mode } = input;
  if (!title || mode !== "afk" && mode !== "hil") return refuse({ kind: "add-slice-usage", story: story2 });
  const notHeld = await checkHeld(ctx, story2);
  if (notHeld) return notHeld;
  const parent = await github.getIssue(story2);
  if (stateOf(parent) !== "needs-slicing") return refuse({ kind: "story-not-slicing", story: story2, state: stateOf(parent) });
  const blockers = await Promise.all(input.blockedBy.map((b) => github.getIssue(b)));
  const open = blockers.filter((b) => b.state === "open");
  const slice = await github.createIssue({
    title,
    body: `Slice of #${story2}. Spec: ${specPath(story2, await storySlug(ctx, parent))}`,
    labels: ["type:slice", `mode:${mode}`, open.length ? "blocked" : "ready-for-agent"],
    assignees: parent.assignees
  });
  await github.addSubIssue(story2, slice.number);
  for (const b of blockers) await github.addBlockedBy(slice.number, b.number);
  return { ok: true, kind: "slice-added", slice: slice.number, title, mode, blockedBy: open.map((b) => b.number) };
}
async function next(ctx, n) {
  const r = await notAStory(ctx.github, n);
  if (r) return refuse(r);
  const report = await computeNext(ctx, n);
  if (report.nothingLeft && !report.closed) await notifyWaiting(ctx, report);
  return { ok: true, kind: "next", report };
}

// packages/core/src/status.ts
async function status(ctx, n) {
  const { github } = ctx;
  const now = ctx.now();
  const staleAfterMs = ctx.config.staleAfterMs;
  const story2 = await github.getIssue(n);
  const slices = await slicesOf(github, n);
  const rows = [];
  for (const s of slices) rows.push(await row(github, s, now, staleAfterMs));
  const head = await row(github, story2, now, staleAfterMs);
  return {
    ok: true,
    kind: "status",
    story: { ...head, owner: story2.assignees[0] ?? null, branch: storyBranch(n, await storySlug(ctx, story2)) },
    slices: rows
  };
}
async function row(github, issue2, now, staleAfterMs) {
  const closed = issue2.state === "closed";
  const claim = closed ? null : await github.readClaim(issue2.number);
  const blockers = closed ? [] : await github.blockedBy(issue2.number);
  return {
    number: issue2.number,
    title: issue2.title,
    status: closed ? issue2.stateReason === "not_planned" ? "closed" : "merged" : "open",
    states: closed ? [] : statesOf(issue2),
    mode: issue2.labels.includes("mode:hil") ? "hil" : issue2.labels.includes("mode:afk") ? "afk" : null,
    blockedBy: blockers.filter((b) => b.state === "open").map((b) => b.number),
    needsHuman: issue2.labels.includes("needs-human"),
    heldSince: claim?.since ?? null,
    stale: claim ? isStale(claim, now, staleAfterMs) : false
  };
}

// packages/core/src/feed.ts
function feedOf(story2, fc) {
  const slices = story2.subIssues.filter((i) => kindOf(i) === "slice");
  const slug = recordedSlug(story2.nornComments.map((c) => c.body)) ?? slugify(story2.title);
  const events = [];
  for (const issue2 of [story2, ...slices]) {
    const base = { issue: issue2.number, story: story2.number };
    const ofIssue = { ...base, url: issue2.url };
    const bodies = issue2.nornComments.map((c) => c.body);
    const transitions = issue2.timeline.flatMap((t) => {
      const c = t.kind === "comment" && t.body !== null ? parseTransitionComment(t.body) : null;
      return c && t.kind === "comment" ? [{ t, c }] : [];
    });
    const near = (list, at, ok) => list.find((x) => Math.abs(Date.parse(x.t.at) - Date.parse(at)) <= MATCH_MS && ok(x));
    const markers = issue2.timeline.flatMap((t) => t.kind === "comment" && t.body !== null ? [{ t, reason: needsHumanIn(t.body) }] : []);
    const branch = issue2 === story2 ? storyBranch(story2.number, slug) : sliceBranch(story2.number, slug, issue2.number);
    const target = issue2 === story2 ? "story" : "slice";
    for (const pr of issue2.pullRequests.filter((p) => p.head === branch)) {
      const at = { ...base, url: pr.url, target, pr: pr.number };
      events.push({ ...at, id: `pr-opened:${pr.number}`, kind: "pr", action: "opened", at: pr.createdAt, actor: pr.author });
      if (pr.mergedAt) events.push({ ...at, id: `pr-merged:${pr.number}`, kind: "pr", action: "merged", at: pr.mergedAt, actor: pr.mergedBy });
    }
    for (const [i, t] of issue2.timeline.entries()) {
      if (t.kind === "comment") {
        if (t.body === null) {
          events.push({ ...base, id: `other:${t.url}`, kind: "other-activity", at: t.at, actor: t.actor, url: t.url, detail: "IssueComment" });
          continue;
        }
        const c = parseTransitionComment(t.body);
        if (!c || c.why === "needs-human resolved") continue;
        const from = STATES.includes(c.from) ? c.from : null;
        const to = targetOf(c.to);
        const at = { ...base, at: t.at, actor: t.actor, url: t.url };
        if (c.why === "automatic") {
          events.push(
            from === "blocked" && to === "ready-for-agent" ? { ...at, id: `slice:${t.url}`, kind: "slice", action: "unblocked" } : { ...at, id: `step:${t.url}`, kind: "step", from, to: to === "not-planned" ? "closed" : to }
          );
          continue;
        }
        const upTo = bodies.slice(0, issue2.nornComments.findIndex((pc) => pc.url === t.url) + 1);
        const step = stepAt(issue2, from);
        const entersFix = FIX_STATES.includes(to) && from !== to;
        const fixRound = entersFix ? fixRounds(upTo.slice(0, -1)) + 1 : step?.skill === "norn-implement" ? fixRounds(upTo) || null : null;
        events.push({
          ...at,
          id: `outcome:${t.url}`,
          kind: "outcome",
          step: step?.name ?? from ?? "triage",
          outcome: c.why ?? "done",
          from,
          to,
          fixRound,
          maxFixRounds: fc.maxFixRounds,
          note: c.note,
          evidence: c.evidence
        });
        if (c.evidence) events.push({ ...at, id: `qa-evidence:${t.url}`, kind: "qa-evidence", evidence: c.evidence });
        continue;
      }
      const id = `${t.kind}:${issue2.number}:${t.at}:${i}`;
      if (t.kind === "labeled" || t.kind === "unlabeled") {
        if (t.label === "needs-human") {
          const raised = t.kind === "labeled";
          const said = raised ? near(markers, t.at, (m) => m.reason !== null) : near(transitions, t.at, (x) => x.c.why === "needs-human resolved");
          const reason = raised ? said?.reason ?? null : null;
          events.push({
            ...ofIssue,
            id,
            kind: "needs-human",
            action: raised ? "raised" : "resolved",
            reason,
            at: t.at,
            actor: t.actor,
            url: said?.t.url ?? issue2.url
          });
          continue;
        }
        if (STATES.includes(t.label)) {
          if (t.kind === "unlabeled") continue;
          const old = issue2.timeline.slice(i + 1).find((u) => u.kind === "unlabeled" && STATES.includes(u.label) && Date.parse(u.at) - Date.parse(t.at) <= MATCH_MS);
          if (old?.kind !== "unlabeled") continue;
          if (near(transitions, t.at, (x) => x.c.to === t.label)) continue;
          const from = old.label;
          const to = t.label;
          events.push(
            from === "blocked" && to === "ready-for-agent" ? { ...ofIssue, id, kind: "slice", action: "unblocked", at: t.at, actor: t.actor } : { ...ofIssue, id, kind: "step", from, to, at: t.at, actor: t.actor }
          );
          continue;
        }
        if (FLAGS.includes(t.label)) continue;
        events.push({
          ...ofIssue,
          id,
          kind: "other-activity",
          detail: t.kind === "labeled" ? "LabeledEvent" : "UnlabeledEvent",
          label: t.label,
          at: t.at,
          actor: t.actor
        });
        continue;
      }
      if (t.kind === "closed") {
        if (near(transitions, t.at, (x) => x.c.to.startsWith("closed"))) continue;
        events.push({ ...ofIssue, id, kind: "step", from: null, to: "closed", at: t.at, actor: t.actor });
        continue;
      }
      if (t.kind === "sub-issue-added") {
        const child = slices.find((s) => s.number === t.child);
        if (child) events.push({ issue: child.number, story: story2.number, url: child.url, id, kind: "slice", action: "created", at: t.at, actor: t.actor });
        continue;
      }
      if (t.kind === "other") events.push({ ...ofIssue, id, kind: "other-activity", detail: t.detail, at: t.at, actor: t.actor, url: t.url ?? issue2.url });
      else events.push({ ...ofIssue, id, kind: "other-activity", detail: "ReopenedEvent", at: t.at, actor: t.actor });
    }
  }
  return newestFirst(events.filter((e) => fc.since === null || e.at > fc.since));
}
var MATCH_MS = 6e4;
function targetOf(to) {
  return to === "closed as not planned" ? "not-planned" : to;
}
function stepAt(issue2, from) {
  const flags = issue2.labels.filter((l) => !STATES.includes(l) && l !== "needs-human");
  return stepFor({ ...issue2, state: "open", labels: from ? [...flags, from] : flags.filter((l) => !l.startsWith("type:")) });
}
function byTime(events) {
  return [...events].sort((a, b) => b.at.localeCompare(a.at));
}
function newestFirst(events) {
  return events.map((e, i) => ({ e, i })).sort((a, b) => b.e.at.localeCompare(a.e.at) || b.i - a.i).map((x) => x.e);
}

// packages/core/src/observe.ts
var WEEK_MS = 7 * 864e5;
async function observe(ctx, opts) {
  const now = ctx.now();
  const me = await ctx.github.currentUser();
  const closedSince = new Date(now.getTime() - WEEK_MS).toISOString();
  const work = await ctx.github.observeWork({ user: me, closedSince, since: opts.since ?? null });
  const claims = new Map(work.claims.flatMap((c) => c.record ? [[c.issue, { ...c.record, sha: c.sha }]] : []));
  const holder = (n) => {
    const c = claims.get(n);
    return c ? { login: c.holder, session: c.session, since: c.since, stale: isStale(c, now, ctx.config.staleAfterMs) } : null;
  };
  const item = (i, story2) => {
    const closed = i.state === "closed";
    const bodies = i.nornComments.map((c) => c.body);
    return {
      number: i.number,
      title: i.title,
      url: i.url,
      status: closed ? i.stateReason === "not_planned" ? "closed" : "merged" : "open",
      states: closed ? [] : statesOf(i),
      labels: [...i.labels],
      mode: i.labels.includes("mode:hil") ? "hil" : i.labels.includes("mode:afk") ? "afk" : null,
      blockedBy: closed ? [] : i.blockedBy.filter((b) => b.state === "open").map((b) => b.number),
      holder: closed ? null : holder(i.number),
      fixRounds: fixRounds(bodies),
      maxFixRounds: ctx.config.maxFixRounds,
      needsHuman: i.labels.includes("needs-human"),
      needsHumanReason: i.labels.includes("needs-human") ? lastNeedsHumanReason(bodies) : null,
      humanQa: story2 || i.labels.includes("mode:hil"),
      latestEvidence: [...bodies].reverse().map((b) => parseTransitionComment(b)?.evidence).find((e) => e) ?? null,
      closedAt: i.closedAt
    };
  };
  const mine = (s) => [s, ...s.subIssues].some((i) => claims.get(i.number)?.holder === me) || s.assignees.includes(me) && (s.state === "open" || (s.closedAt ?? "") >= closedSince);
  const board = work.stories.filter(mine).map((s) => {
    const slug = recordedSlug(s.nornComments.map((c) => c.body)) ?? slugify(s.title);
    return {
      ...item(s, true),
      owner: s.assignees[0] ?? null,
      branch: storyBranch(s.number, slug),
      slices: s.subIssues.filter((i) => kindOf(i) === "slice").map((i) => item(i, false))
    };
  });
  const waiting = [];
  for (const s of work.stories.filter((s2) => s2.assignees.includes(me) && s2.state === "open")) {
    for (const i of [s, ...s.subIssues.filter((i2) => kindOf(i2) === "slice")]) {
      if (i.state !== "open") continue;
      const kind = i.labels.includes("needs-human") ? "needs-human" : stateOf(i) === "needs-human-qa" ? "needs-human-qa" : null;
      if (!kind) continue;
      const bodies = i.nornComments.map((c) => c.body);
      const entered = [...i.nornComments].reverse().find((c) => kind === "needs-human" ? needsHumanIn(c.body) !== null : parseTransitionComment(c.body)?.to === "needs-human-qa");
      waiting.push({
        issue: i.number,
        story: s.number,
        title: i.title,
        kind,
        reason: kind === "needs-human" ? lastNeedsHumanReason(bodies) : null,
        since: entered?.at ?? null,
        command: `norn-drive ${i.number}`
      });
    }
  }
  waiting.sort((a, b) => a.kind === b.kind ? (a.since ?? "").localeCompare(b.since ?? "") : a.kind === "needs-human" ? -1 : 1);
  const snapshot = [...claims].map(([issue2, c]) => ({ issue: issue2, sha: c.sha, login: c.holder, session: c.session, since: c.since }));
  const feed = board.length ? work.stories.filter(mine).flatMap((s) => feedOf(s, { maxFixRounds: ctx.config.maxFixRounds, since: opts.since ?? null })) : [];
  if (opts.previous) feed.push(...claimEvents(board, opts.previous, snapshot, now, ctx.config.staleAfterMs));
  return {
    ok: true,
    kind: "observation",
    me,
    repoUrl: work.repoUrl,
    at: now.toISOString(),
    board,
    waiting,
    feed: byTime(feed),
    claims: snapshot
  };
}
function claimEvents(board, last, current, now, staleAfterMs) {
  const previous = last.claims;
  const items = new Map(board.flatMap((s) => [s, ...s.slices].map((i) => [i.number, { story: s.number, url: i.url }])));
  const before = new Map(previous.map((c) => [c.issue, c]));
  const after = new Map(current.map((c) => [c.issue, c]));
  const events = [];
  const event = (c, action, at) => {
    const item = items.get(c.issue);
    if (item)
      events.push({ id: `claim-${action}:${c.issue}:${c.sha}`, kind: "claim", action, issue: c.issue, ...item, at, actor: c.login, session: c.session });
  };
  for (const c of previous) if (after.get(c.issue)?.session !== c.session) event(c, "released", now.toISOString());
  for (const c of current) {
    if (before.get(c.issue)?.sha !== c.sha) event(c, "taken", c.since);
    const staleAt = new Date(Date.parse(c.since) + staleAfterMs).toISOString();
    if (staleAt <= now.toISOString() && staleAt > last.at) event(c, "stale", staleAt);
  }
  return events;
}

// packages/cli/src/dashboard.ts
var DEFAULT_DASHBOARD_PORT = 4477;
var DEFAULT_DASHBOARD_INTERVAL_MS = 2 * 6e4;
var DASHBOARD_INTERVAL_FLOOR_MS = 3e4;
async function dashboard(ctx, flags, bools) {
  const portFlag = flags.port?.[0];
  if (portFlag !== void 0 && !(/^\d+$/.test(portFlag) && Number(portFlag) > 0 && Number(portFlag) < 65536)) {
    return { ok: false, refusal: { kind: "bad-dashboard-flag", flag: "port" } };
  }
  const intervalFlag = flags.interval?.[0];
  const flagMs = intervalFlag === void 0 ? null : durationMs(intervalFlag);
  if (intervalFlag !== void 0 && flagMs === null) return { ok: false, refusal: { kind: "bad-dashboard-flag", flag: "interval" } };
  const port = portFlag !== void 0 ? Number(portFlag) : ctx.config.dashboard.port ?? DEFAULT_DASHBOARD_PORT;
  const asked = flagMs ?? ctx.config.dashboard.intervalMs ?? DEFAULT_DASHBOARD_INTERVAL_MS;
  const intervalMs = Math.max(asked, DASHBOARD_INTERVAL_FLOOR_MS);
  const raisedFrom = asked < DASHBOARD_INTERVAL_FLOOR_MS ? intervalFlag ?? `${asked / 1e3}s` : null;
  const launch = await ctx.dashboard({ root: ctx.workspace.root, port, explicitPort: portFlag !== void 0, intervalMs, open: !bools.has("no-open") });
  if (launch.kind === "port-taken") return { ok: false, refusal: launch };
  return { ok: true, kind: "dashboard", launch, port, intervalMs, raisedFrom };
}

// packages/cli/src/init.ts
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join as join4 } from "node:path";
var SKILLS = [
  "norn-triage",
  "norn-refine",
  "norn-clarify",
  "norn-plan",
  "norn-slice",
  "norn-implement",
  "norn-review",
  "norn-auto-qa",
  "norn-qa",
  "norn-merge",
  "norn-resolve",
  "norn-drive",
  "norn-deliver",
  "norn-tdd",
  "norn-interview",
  "norn-codebase-design"
];
var DESCRIPTIONS = {
  "needs-refinement": ["c5def5", "Triaged; the spec is being refined"],
  "needs-clarification": ["fbca04", "Refinement found questions or unknowns"],
  "needs-plan": ["c5def5", "All questions answered; plan goes into the spec"],
  "needs-slicing": ["c5def5", "Plan done; slices to be created"],
  blocked: ["b60205", "Has an open native blocked-by relation"],
  "ready-for-agent": ["0e8a16", "Unblocked, can be picked up"],
  implementation: ["1d76db", "Story: slices in progress. Slice: implement"],
  "needs-review": ["5319e7", "Code review of the slice PR or the story PR"],
  "changes-requested": ["d93f0b", "Review asked for changes"],
  "needs-qa": ["5319e7", "QA by an agent, with evidence"],
  "needs-human-qa": ["e99695", "QA by a person, after the agent's"],
  "qa-failed": ["d93f0b", "QA found problems"],
  "merge-queue": ["0e8a16", "Implementation done, review has no requests, QA passed"],
  "type:story": ["ededed", "norn story state machine"],
  "type:slice": ["ededed", "norn slice state machine"],
  "in-progress": ["fef2c0", "Someone holds the claim (mirror of the git-ref claim)"],
  "needs-human": ["e11d21", "A person is needed; cleared with the norn-resolve skill"],
  "mode:afk": ["bfdadc", "QA by an agent only"],
  "mode:hil": ["bfdadc", "QA by an agent, then by a person"]
};
function labelDefinitions() {
  return [...STATES, ...FLAGS].map((name) => ({ name, color: DESCRIPTIONS[name][0], description: DESCRIPTIONS[name][1] }));
}
async function init({ github, cwd, installSkills: installSkills2 }) {
  const updated = await installSkills2(cwd);
  const skillsDir = join4(cwd, "skills");
  const installed = existsSync(skillsDir) ? readdirSync(skillsDir).filter((d) => existsSync(join4(skillsDir, d, "SKILL.md"))) : [];
  const missing = SKILLS.filter((s) => !installed.includes(s));
  if (missing.length) return { ok: false, refusal: { kind: "missing-skills", missing } };
  const linkDir = join4(cwd, ".claude", "skills");
  mkdirSync(linkDir, { recursive: true });
  for (const name of installed) {
    const link = join4(linkDir, name);
    if (exists(link)) continue;
    symlinkSync(join4("..", "..", "skills", name), link, "dir");
  }
  const specs = join4(cwd, ".agents", "specs");
  mkdirSync(specs, { recursive: true });
  if (readdirSync(specs).length === 0) writeFileSync(join4(specs, ".gitkeep"), "");
  const teamConfig = join4(cwd, TEAM_CONFIG);
  if (!existsSync(teamConfig)) {
    const config = { ...DEFAULT_TEAM_CONFIG, baseBranch: await github.defaultBranch() };
    writeFileSync(teamConfig, `${JSON.stringify(config, null, 2)}
`);
  }
  ensureGitignored(cwd, [".agents/worktrees/", LOCAL_CONFIG]);
  const instructed = writeAgentInstructions(cwd);
  await github.ensureLabels(labelDefinitions());
  return { ok: true, kind: "initialized", skills: installed.length, updated, instructed, labels: labelDefinitions().length };
}
function exists(p) {
  try {
    lstatSync(p);
    return true;
  } catch {
    return false;
  }
}
function ensureGitignored(cwd, entries) {
  const file = join4(cwd, ".gitignore");
  let text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const present = new Set(text.split("\n").map((l) => l.trim()));
  const missing = entries.filter((e) => !present.has(e));
  if (!missing.length) return;
  if (text && !text.endsWith("\n")) text += "\n";
  writeFileSync(file, text + missing.map((e) => `${e}
`).join(""));
}
var START = "<!-- norn:start -->";
var END = "<!-- norn:end -->";
var AGENT_INSTRUCTIONS = [
  START,
  "## norn",
  "",
  "This repository runs its work through norn. GitHub labels, relations, comments and branches hold the state, and only norn changes them.",
  "",
  "- To work on an issue, use the norn-drive skill: `norn-drive <issue>`. It takes the issue through the attended steps with the user.",
  "- To run a sliced story unattended, use the norn-deliver skill: `norn-deliver <story>`.",
  "- Without the skills: `norn next <issue>` says what can be done now, and `norn take <issue>` claims an item and gives the briefing to follow to the end. Use `npx norn` if `norn` is not on the PATH.",
  "- Never change norn's labels, claims or branches by hand.",
  END
].join("\n");
function writeAgentInstructions(cwd) {
  const agents = join4(cwd, "AGENTS.md");
  const claude = join4(cwd, "CLAUDE.md");
  if (!existsSync(agents) && !existsSync(claude)) {
    writeFileSync(agents, `${AGENT_INSTRUCTIONS}
`);
    writeFileSync(claude, "@AGENTS.md\n");
    return ["AGENTS.md", "CLAUDE.md"];
  }
  const written = [];
  for (const [name, file] of [
    ["AGENTS.md", agents],
    ["CLAUDE.md", claude]
  ]) {
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    if (name === "CLAUDE.md" && existsSync(agents) && /^@AGENTS\.md\s*$/m.test(text)) continue;
    const start = text.indexOf(START);
    const end = text.indexOf(END, start);
    const next2 = start !== -1 && end !== -1 ? text.slice(0, start) + AGENT_INSTRUCTIONS + text.slice(end + END.length) : `${(text ? text.replace(/\n*$/, "\n\n") : "") + AGENT_INSTRUCTIONS}
`;
    writeFileSync(file, next2);
    written.push(name);
  }
  return written;
}

// packages/cli/src/render-text.ts
function unreachable(x) {
  throw new Error(`no wording for ${JSON.stringify(x)}`);
}
function wrap(text, width = 76) {
  return text.split("\n").map((line) => {
    const out = [];
    let cur = "";
    for (const word of line.split(" ")) {
      if (cur && `${cur} ${word}`.length > width) {
        out.push(cur);
        cur = word;
      } else cur = cur ? `${cur} ${word}` : word;
    }
    out.push(cur);
    return out.join("\n");
  }).join("\n");
}
function hhmm(iso) {
  return iso.slice(11, 16);
}
var issues = (ns) => ns.map((b) => `#${b}`).join(", ");
var USAGE = [
  "norn runs work through the SDD process. Commands on an issue take its number explicitly.",
  "",
  "  norn init                          Set up this project: skills, .agents/specs/, labels",
  "  norn next <story>                  What can be done on the story now",
  "  norn take <issue> [--takeover]     Claim the issue and get the briefing for its step;",
  "                                     --takeover takes it from a stopped session of yours",
  '  norn done <issue> [outcome] ["note"] [--evidence <dir>]',
  "                                     Finish the step; norn makes the transition.",
  "                                     --evidence attaches the QA files in <dir>",
  '  norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  '  norn escalate <issue> "reason"     Set needs-human and release the claim',
  "  norn release <issue>               Give up the claim without a transition",
  "  norn status <story>                Read-only overview of the story and its slices",
  "  norn tidy [--dry-run]              Remove what belongs to closed issues",
  "  norn dashboard [--port <n>] [--interval <duration>] [--no-open]",
  "                                     Watch your work in the browser; Ctrl-C stops it",
  "",
  "Add --json for machine-readable output."
].join("\n");
var NEEDS_NUMBER = {
  next: "norn next <story>",
  take: "norn take <issue>",
  done: 'norn done <issue> [outcome] ["note"] [--evidence <dir>]',
  "add-slice": 'norn add-slice <story> "title" --mode afk|hil [--blocked-by <issue>]...',
  escalate: 'norn escalate <issue> "reason"',
  release: "norn release <issue>",
  status: "norn status <story>"
};
function ghFailureMessage(argv, error) {
  const { positionals } = parseArgs(argv);
  const [cmd, n] = positionals;
  const lines = ["GitHub refused a call. Some changes from this command may already be applied.", error];
  if (cmd && n && /^\d+$/.test(n)) {
    lines.push(
      `See where things stand with: norn status ${n} (for a slice, norn status <its story> shows the whole story)`,
      `Check gh auth status and that you are inside the repository, then retry: norn ${argv.map(sh).join(" ")}`
    );
  } else {
    lines.push("Check gh auth status and that you are inside the repository, then retry the command.");
  }
  return lines.join("\n");
}
function problem(p) {
  switch (p.kind) {
    case "not-an-object":
      return `${p.file}: must be a JSON object`;
    case "invalid-json":
      return `${p.file}: not valid JSON (${p.detail})`;
    case "unknown-setting":
      return `${p.file}: unknown setting "${p.key}"`;
    case "bad-base-branch":
      return `${p.file}: baseBranch must be a branch name`;
    case "bad-provider":
      return `${p.file}: worktrees.provider must be one of ${p.allowed.join(", ")}`;
    case "bad-stale-after":
      return `${p.file}: claims.staleAfter must be a duration like 90m or 2h`;
    case "notifications-in-team-file":
      return `${p.file}: notifications is set per developer in ${p.local}`;
    case "bad-notifications":
      return `${p.file}: notifications must be one of ${p.allowed.join(", ")}`;
    case "bad-deliver-number":
      return `${p.file}: deliver.${p.key} must be a whole number above 0`;
    case "dashboard-in-team-file":
      return `${p.file}: dashboard is each developer's own; set it in ${p.local}`;
    case "bad-dashboard-setting":
      return p.key === "port" ? `${p.file}: dashboard.port must be a port number` : `${p.file}: dashboard.interval must be a duration like 30s or 2m`;
    default:
      return unreachable(p);
  }
}
function renderWarning(w) {
  switch (w.kind) {
    case "stale-after-clamped":
      return `${w.file}: claims.staleAfter ${w.value} is below the ${w.minimum} minimum, so norn uses ${w.minimum}; shorter, and live claims get taken over`;
    case "team-setting-in-local-file":
      return `${w.file}: ${w.setting} is shared by the team, so norn ignores it here; set it in ${w.team}`;
    default:
      return unreachable(w);
  }
}
function finishLines(finish) {
  if (finish.length === 1 && finish[0].word === "") return [`  norn done ${finish[0].issue}`];
  const cmds = finish.map((f) => `norn done ${f.issue} ${f.word}${f.note ? ` "${f.note}"` : ""}${f.evidence ? " [--evidence <dir>]" : ""}`);
  const width = Math.max(...cmds.map((c) => c.length)) + 3;
  return cmds.map((c, i) => `  ${c.padEnd(width)}(${finish[i].means})`);
}
var pick = (story2) => story2 ? `Run norn next ${story2} and pick a different item.` : "Pick a different item.";
function renderRefusal(r) {
  switch (r.kind) {
    case "usage":
      return [USAGE];
    case "needs-number":
      return ["Give the issue number explicitly:", `  ${NEEDS_NUMBER[r.command]}`];
    case "port-taken":
      return [`Port ${r.port} is taken. Pick another with --port, or leave it out to use the next free one.`];
    case "bad-dashboard-flag":
      return [r.flag === "port" ? "--port takes a port number, e.g. 4477." : "--interval takes a duration such as 30s, 2m or 1h."];
    case "missing-skills":
      return [`Missing skills: ${r.missing.join(", ")}. The skill install did not provide them into skills/.`, "Fix the install and run norn init again."];
    case "config-invalid":
      return ["norn cannot read its configuration:", ...r.problems.map((p) => `  ${problem(p)}`), "Fix the file and run the command again."];
    case "provider-mismatch": {
      const start = r.provider === "herdr" ? "Start from a herdr pane" : "Start from a Claude Code session";
      return [`The worktree provider is ${r.provider}, but ${r.variable} is not set.`, `${start}, or switch the provider in ${LOCAL_CONFIG}.`];
    }
    case "closed":
      return [`#${r.issue} is closed. There is nothing to do on it.`];
    case "ambiguous-state":
      return [`#${r.issue} has more than one state label (${r.states.join(", ")}); a person must remove the stale one.`, pick(r.story)];
    case "story-in-implementation":
      return [
        `Story #${r.issue} is in implementation. Its label follows its slices; there is no step to take on the story itself.`,
        `Run norn next ${r.issue} to see its slices.`
      ];
    case "story-in-merge-queue":
      return [
        `Story #${r.issue} is in merge-queue. Only the story owner (${r.owner ? `@${r.owner}` : "unassigned"}) merges the story PR;`,
        `once it is merged, norn next ${r.issue} closes the story if GitHub has not. Do not merge it yourself.`
      ];
    case "blocked":
      return [`#${r.issue} is blocked by ${issues(r.blockers) || "other issues"}. Do not work on it yet.`, pick(r.story)];
    case "no-step":
      return [`#${r.issue} (${r.state ?? "no state"}) has no step norn can brief.`, pick(r.story)];
    case "held":
      return [
        `${heldWhat(r)} is already held by another session (since ${heldSince(r.since)}).`,
        `Do not work on it.${r.story ? ` Run norn next ${r.story} and pick a different item.` : ""}`
      ];
    case "held-by-your-session":
      return [
        `${heldWhat(r)} is held by another session of yours (since ${heldSince(r.since)}).`,
        `If that session has stopped, take it over here: norn take ${r.issue} --takeover`,
        "If it is still running, do not work on it."
      ];
    case "held-by-teammate":
      return [
        `${heldWhat(r)} is held by @${r.holder} (since ${heldSince(r.since)}). --takeover only takes over your own sessions.`,
        "Ask them to release it, or wait until the claim goes stale."
      ];
    case "not-claimed":
      return [`You do not hold #${r.issue}. Claim it first with: norn take ${r.issue}`];
    case "held-by-other-session":
      return [`#${r.issue} is held by another session (since ${hhmm(r.since)}). Do not work on it or finish it.`];
    case "outcome-missing":
      return [`${r.step} can end more than one way. Say which.`, "Finish with one of:", ...finishLines(r.finish)];
    case "outcome-unknown":
      return [`"${r.word}" is not an outcome of ${r.step}.`, "Finish with one of:", ...finishLines(r.finish)];
    case "note-missing":
      return [`This outcome needs a ${r.note}. Run:`, `  norn done ${r.issue} ${r.word} "${r.note}"${r.evidence ? " [--evidence <dir>]" : ""}`];
    case "evidence-not-allowed":
      return [`--evidence is for QA steps; ${r.step} takes none. Finish without it:`, ...finishLines(r.finish)];
    case "evidence-not-a-directory":
      return [`${r.dir} is not a directory. Put the evidence files in a directory and pass its path to --evidence.`];
    case "evidence-empty":
      return [`${r.dir} is empty. Put the evidence files in it, or finish without --evidence.`];
    case "evidence-too-big":
      return [
        `These files are over ${r.limitBytes / 1024 / 1024} MB, too big to push as evidence: ${r.files.join(", ")}.`,
        "Trim them, e.g. cut a log to the part that shows the result, and run the command again."
      ];
    case "no-slices":
      return [
        `Story #${r.issue} has no slices yet. Create them first, one per slice, with:`,
        `  norn add-slice ${r.issue} "title" --mode afk|hil [--blocked-by <issue>]`
      ];
    case "not-in-story":
      return [`#${r.issue} is not a sub-issue of a story.`];
    case "no-slice-pr":
      return [`No PR from ${r.head} was found. Open and merge it before running norn done ${r.issue}.`];
    case "slice-pr-wrong-base":
      return [
        `PR #${r.pr} from ${r.head} targets ${r.base}, not the story branch ${r.storyBranch}.`,
        r.merged ? `Its changes are not on ${r.storyBranch}, and a person must sort that out. Run: norn escalate ${r.issue} ${sh(`slice PR #${r.pr} was merged into ${r.base}, not ${r.storyBranch}`)}` : `Retarget it with: gh pr edit ${r.pr} --base ${sh(r.storyBranch)}, then merge it and run norn done ${r.issue}.`
      ];
    case "slice-pr-not-merged":
      return [`PR #${r.pr} from ${r.head} is not merged yet.`, `Merge it into ${r.base} (resolve conflicts if needed), then run norn done ${r.issue}.`];
    case "base-branch-missing":
      return [
        `The story branch ${r.branch} would start from ${r.base}, but ${r.base} does not exist on GitHub.`,
        `Set baseBranch in ${TEAM_CONFIG} to the repository's default branch and run the command again.`
      ];
    case "reason-missing":
      return ["Say why a human is needed. Run:", `  norn escalate ${r.issue} "reason"`];
    case "add-slice-usage":
      return ["add-slice needs a title and a mode. Run:", `  norn add-slice ${r.story} "title" --mode afk|hil [--blocked-by <issue>]...`];
    case "story-not-slicing":
      return [`Story #${r.story} is in ${r.state ?? "no state"}, not needs-slicing. Slices are only added while slicing.`];
    case "is-a-slice":
      return [`#${r.issue} is a slice${r.story ? ` of story #${r.story}. Run norn next ${r.story}` : ""} instead.`];
    case "not-a-story":
      return [`#${r.issue} is not a story yet. Triage it first with: norn take ${r.issue}`];
    default:
      return unreachable(r);
  }
}
var heldWhat = (r) => `${r.slice ? "Slice " : ""}#${r.issue}`;
var heldSince = (since) => since ? hhmm(since) : "unknown";
var TASKS = {
  "unblock-slices": "unblock the slices waiting on it",
  "move-story-on": "move the story on",
  "close-merged-story": "close the merged story"
};
function renderEvent(e) {
  switch (e.kind) {
    case "story-branch-created":
      return [`Created the story branch ${e.branch}.`];
    case "story-branch-failed":
      return [`Could not create the story branch: ${e.detail}`];
    case "base-branch-missing":
      return renderRefusal(e);
    case "worktree-left-for-tidy":
      return [`Its worktree ${e.worktree} is removed by the next norn tidy.`];
    case "slice-state-changed":
      return [`#${e.issue} is now ${e.state}.`];
    case "story-promoted":
      return [`Every slice is merged. Story #${e.story} is now in needs-review.`];
    case "story-closed":
      return [`The story PR is merged. Closed story #${e.story}.`];
    case "follow-up-failed": {
      const what = e.what === "clear-labels" ? `clear the labels of #${e.issue}` : TASKS[e.what];
      return [`Could not ${what}: ${e.detail}. norn next ${e.retry} will retry this.`];
    }
    default:
      return unreachable(e);
  }
}
function renderAnswer(a) {
  switch (a.kind) {
    case "taken":
      return renderTake(a);
    case "done":
      return renderDone(a);
    case "escalated":
      return [`#${a.issue} now needs a human. The claim is released.`, "Do not work on it further. A person picks it up with the norn-resolve skill."];
    case "released":
      return [`Released #${a.issue}. Its state is unchanged. Do not work on it further.`];
    case "slice-added": {
      const status2 = a.blockedBy.length ? `blocked by ${issues(a.blockedBy)}` : "ready-for-agent";
      return [`Created slice #${a.slice} "${a.title}" (mode:${a.mode}, ${status2}).`];
    }
    case "next":
      return [renderNext(a.report)];
    case "status":
      return renderStatus(a);
    case "tidy":
      return [renderTidy(a)];
    case "dashboard":
      return renderDashboard(a);
    case "initialized":
      return [
        "norn is set up in this project:",
        `  - ${a.skills} skills in skills/, linked into .claude/skills/`,
        ...a.updated.length ? [`  - updated to this norn version: ${a.updated.join(", ")} (git diff skills/ shows the changes)`] : [],
        "  - .agents/specs/ for story specs",
        `  - ${TEAM_CONFIG} with the team settings (each developer can override in ${LOCAL_CONFIG})`,
        "  - .agents/worktrees/ and the local config in .gitignore",
        `  - how to work with norn in ${a.instructed.join(" and ")}`,
        `  - ${a.labels} labels on the repository`,
        "",
        `Commit skills/, .claude/skills/, .agents/, .gitignore and ${a.instructed.join(", ")}. Then ask your agent: norn-drive <issue>`
      ];
    default:
      return unreachable(a);
  }
}
function duration(ms) {
  if (ms % 36e5 === 0) return `${ms / 36e5}h`;
  if (ms % 6e4 === 0) return `${ms / 6e4}m`;
  return `${Math.round(ms / 1e3)}s`;
}
function renderDashboard(a) {
  const raised = a.raisedFrom ? [`norn warning: --interval ${a.raisedFrom} is below the 30s floor, so the dashboard reads GitHub every ${duration(a.intervalMs)}.`] : [];
  if (a.launch.kind === "already-running") return [...raised, `norn dashboard is already running for this repository at ${a.launch.url}.`];
  const where = `norn dashboard is running at ${a.launch.url} and reads GitHub every ${duration(a.intervalMs)}.`;
  return [
    ...raised,
    a.launch.port === a.port ? where : `Port ${a.port} is taken, so ${where}`,
    `${a.launch.opened ? "Opened it" : "Open it"} in your browser. Stop it with Ctrl-C.`
  ];
}
function checkedOutElsewhere(branch, path) {
  return `Branch ${branch} is checked out at ${path}; work there or switch that checkout to another branch.`;
}
function renderBriefing(b) {
  const n = b.issue;
  const { step } = b;
  let where = `You now hold ${b.noun} #${n} "${b.title}". Its step is ${step.name}.`;
  if (step.attended) where += " This step is attended: the user takes part, and you do not decide on your own.";
  const when = step.attended ? `When the user agrees ${step.name} is finished` : `When ${step.name} is finished`;
  const workIn2 = [];
  if (b.workIn) {
    const { path, branch, worktree } = b.workIn;
    workIn2.push(`Work in: ${path} (branch ${branch})`);
    if (worktree.kind === "checked-out-elsewhere") workIn2.push(checkedOutElsewhere(branch, worktree.at));
    else if (worktree.kind === "missing") workIn2.push("It does not exist yet. Create it first:", `  ${worktree.create}`);
    else {
      if (worktree.dirty) workIn2.push("It has uncommitted changes, e.g. from an earlier session. Check git status there before you start.");
      if (worktree.update) workIn2.push("Bring it up to date first:", `  ${worktree.update}`);
    }
    workIn2.push("");
  }
  return [
    wrap(where),
    "",
    ...workIn2,
    `Invoke the skill: ${step.skill}`,
    ...b.instructions,
    "",
    `${when}, run${b.finish.length > 1 ? " one of" : ""}:`,
    ...finishLines(b.finish),
    "",
    `On a long step, run norn take ${n} again now and then: it keeps your claim fresh.`,
    `If you have to stop, run: norn release ${n}`,
    `If something is wrong and a person is needed, run: norn escalate ${n} "reason"`,
    "",
    "Do not change labels yourself. Only norn changes them."
  ];
}
function renderTake(t) {
  const n = t.issue;
  const lines = renderBriefing(t.briefing);
  if (t.tookOver) {
    const since = hhmm(t.tookOver.since);
    const was = t.tookOver.own ? `You took #${n} over from another session of yours (since ${since})` : `The previous holder's claim was stale (since ${since})`;
    const note = `${was}${t.tookOver.worktreeKept ? "; its worktree is kept with what it left. Check git status there before you start." : "."}`;
    lines.splice(lines.indexOf(""), 0, "", note);
  }
  if (t.reacquired) lines.unshift(`You already held #${n}; the claim is refreshed. Here is its briefing again.`, "");
  return lines;
}
function renderDone(d) {
  const n = d.issue;
  const where = d.to === "closed" ? "closed" : d.to === "not-planned" ? "closed as not planned" : `in ${d.to}`;
  const lines = [`#${n} is now ${where}. The claim is released.`];
  if (d.evidence) {
    const count = d.evidence.files.length;
    lines.push(`Pushed ${count} evidence file${count === 1 ? "" : "s"} to ${d.evidence.branch} and embedded them in the comment.`);
  }
  if (d.fixLimit !== null) lines.push(`#${n} has reached ${d.fixLimit} fix rounds, so it now needs a human instead of another round of implement.`);
  if (d.storyBranchCreated) lines.push(...renderEvent({ kind: "story-branch-created", branch: d.storyBranchCreated }));
  lines.push(...d.followUps.flatMap(renderEvent));
  if (d.deliverable) lines.push(`To run the story unattended until it needs a human, the user can start the norn-deliver skill: norn-deliver ${n}`);
  if (d.personNext) lines.push(`A person does the next step, so do not take #${n} again. norn has notified the user.`);
  return lines;
}
function rowState(r) {
  if (r.status !== "open") return r.status;
  if (r.states.length > 1) return `${r.states.join(" + ")} (more than one state label)`;
  return r.states[0] ?? "untriaged";
}
function renderStatus(s) {
  const describe = (r) => {
    const state = rowState(r);
    const parts = [state === "blocked" && r.blockedBy.length ? `blocked by ${issues(r.blockedBy)}` : state];
    if (r.mode && state !== "merged" && state !== "closed") parts.push(`mode:${r.mode}`);
    if (r.needsHuman) parts.push("needs-human");
    if (r.heldSince) parts.push(`held since ${hhmm(r.heldSince)}${r.stale ? " (stale)" : ""}`);
    return parts.join(" \xB7 ");
  };
  const { story: story2, slices } = s;
  const lines = [`Story #${story2.number} "${story2.title}": ${describe(story2)} \xB7 owner ${story2.owner ? `@${story2.owner}` : "none"} \xB7 branch ${story2.branch}`];
  if (slices.length) {
    lines.push(`Slices (${slices.filter((r) => r.status === "merged").length} of ${slices.length} merged):`);
    const names = slices.map((r) => `#${r.number} "${r.title}"`);
    const width = Math.max(...names.map((x) => x.length)) + 3;
    for (const [i, r] of slices.entries()) lines.push(`  ${names[i].padEnd(width)}${describe(r)}`);
  } else lines.push("No slices yet.");
  return lines;
}
function renderRemoval(r) {
  switch (r.kind) {
    case "qa-branch":
      return `QA evidence branch ${r.branch} (#${r.issue} is closed)`;
    case "worktree":
      return `worktree ${r.path} (${r.of} #${r.issue} is closed)`;
    case "local-branch":
      return `local branch ${r.branch} (merged into ${r.into})`;
    case "remote-branch":
      return `branch ${r.branch} on GitHub (merged into ${r.into})`;
    case "claim":
      return `claim on #${r.issue} (#${r.issue} is closed)`;
    default:
      return unreachable(r);
  }
}
function renderKept(k) {
  switch (k.kind) {
    case "worktree-in-use":
      return `${k.path}: norn is running inside it. Run norn tidy from another directory to remove it.`;
    case "worktree-dirty":
      return `${k.path}: it has uncommitted changes. Commit and push them, or remove it by hand when done.`;
    case "worktree-unpushed":
      return `${k.path}: branch ${k.branch} has commits that are not on GitHub. Push them, or remove it by hand when done.`;
    case "branch-checked-out":
      return `branch ${k.branch}: it is checked out at ${k.at}. Switch that checkout to another branch to let norn tidy remove it.`;
    case "branch-unpushed":
      return `branch ${k.branch}: it has commits that are not on GitHub. Push them, or delete it by hand.`;
    default:
      return unreachable(k);
  }
}
function tidyNotes(r) {
  return r.fetchFailed === null ? [] : [`Could not fetch from GitHub, so work pushed since the last fetch counts as unpushed and is kept: ${r.fetchFailed}`];
}
var renderFailure = (f) => `${renderRemoval(f.removal)}: ${f.detail}`;
function renderTidy(r) {
  const notes = tidyNotes(r);
  const out = [...notes];
  if (r.removed.length) {
    out.push(r.dryRun ? "norn tidy would remove (dry run, nothing was changed):" : "norn tidy removed:", ...r.removed.map((x) => `  - ${renderRemoval(x)}`));
  }
  if (r.kept.length) out.push("Kept, so no work is lost:", ...r.kept.map((x) => `  - ${renderKept(x)}`));
  if (r.failed.length) out.push("Could not remove, the rest still ran:", ...r.failed.map((x) => `  - ${renderFailure(x)}`));
  if (out.length === notes.length) out.push("Nothing to tidy: nothing is left of closed issues.");
  return out.join("\n");
}
var DESCRIBE = {
  "ready-for-agent": "is ready-for-agent",
  implementation: "is in implementation with no one holding it",
  "needs-review": "needs review",
  "changes-requested": "has changes requested",
  "needs-qa": "needs QA by an agent",
  "qa-failed": "failed QA",
  "merge-queue": "is in merge-queue"
};
function holderText(h) {
  const who = { this: "this session", yours: "another session of yours", other: "another session" }[h.session];
  return `${who} (since ${hhmm(h.since)})`;
}
function waitDetail(w) {
  switch (w.reason) {
    case "blocked":
      return `is blocked by ${issues(w.blockers)}`;
    case "needs-human":
      return w.why ?? "see its latest comment";
    case "human-qa":
      return `needs human QA (${w.of})`;
    case "held":
      return `is held by ${holderText(w.holder)}`;
    case "owner-merge":
      return `waits for its owner (${w.owner ? `@${w.owner}` : "the story owner"}) to merge the story PR into ${w.into}`;
    case "no-state":
      return "has no state label; a person must set one";
    case "ambiguous-state":
      return `has more than one state label (${w.states.join(", ")}); a person must remove the stale one`;
    default:
      return unreachable(w);
  }
}
var heldByOf = (w) => "heldBy" in w ? w.heldBy : void 0;
function humanHandOff(w) {
  if (w.reason !== "needs-human" && w.reason !== "human-qa") return [];
  if (!w.worktree || w.heldBy) return [];
  if (w.here) return ["    You are in its worktree: if the user does it now, take it in this session."];
  if (w.checkedOutAt && w.branch) return [`    ${checkedOutElsewhere(w.branch, w.checkedOutAt)}`];
  return [
    "    If the user does it now, hand it to an agent in its worktree:",
    ...w.createWorktree ? [`      Create the worktree: ${w.createWorktree}`] : [],
    `      herdr agent start norn-${w.issue} --kind claude --pane <pane of ${w.worktree}>`,
    `      herdr agent prompt norn-${w.issue} "norn-drive ${w.issue}"`,
    `      herdr agent focus norn-${w.issue}`
  ];
}
function humanDetail(w) {
  const held = heldByOf(w);
  return `${waitDetail(w)}${held ? `, held by ${holderText(held)}` : ""}`;
}
function waitLine(w) {
  const dont = "here" in w && w.here ? "" : " Do not take it.";
  if (w.reason === "needs-human") return `  - #${w.issue} needs a human: ${humanDetail(w)}.${dont}`;
  if (w.reason === "human-qa") return `  - #${w.issue} ${humanDetail(w)}.${dont}`;
  return `  - #${w.issue} ${waitDetail(w)}.`;
}
function renderNothingLeft(r) {
  const human = r.waiting.filter((w) => FOR_HUMAN.includes(w.reason));
  const blocked = r.waiting.filter((w) => w.reason === "blocked");
  const out = [...r.notes.flatMap(renderEvent), `Story #${r.story} "${r.title}": nothing left that you can do.`];
  if (human.length) out.push("Waiting for a human:", ...human.flatMap((w) => [`  - #${w.issue} ${humanDetail(w)}.`, ...humanHandOff(w)]));
  if (blocked.length) out.push("Blocked until then:", ...blocked.map(waitLine));
  out.push(`Stop here and report to the user.${r.notified ? " norn has already notified them." : ""}`);
  return out.join("\n");
}
function runningNote(r) {
  if (!r.running) return "";
  return ` (${r.running} of your agents ${r.running === 1 ? "is" : "are"} running, the limit is ${r.maxParallel})`;
}
function renderNext(r) {
  const notes = r.notes.flatMap(renderEvent);
  if (r.closed) {
    return [...notes, `Story #${r.story} "${r.title}" is closed${r.notPlanned ? " as not planned" : ""}. Nothing left that you can do.`].join("\n");
  }
  if (r.nothingLeft) return renderNothingLeft(r);
  const out = [];
  if (notes.length) out.push(...notes, "");
  let head = `Story #${r.story} "${r.title}" is in ${r.state ?? "no state"}.`;
  if (r.slices.total) head += ` ${r.slices.merged} of ${r.slices.total} slices are merged into ${r.branch}.`;
  out.push(wrap(head), "");
  if (r.start.length === 0) {
    out.push(`Nothing can be started now. Wait for the running items to finish, then run norn next ${r.story} again.`);
  } else if (r.slots === 0 && r.start.every((s) => !s.attended)) {
    const ready = `${r.start.length} item${r.start.length === 1 ? " is" : "s are"} ready`;
    out.push(
      wrap(
        `${ready}, but ${r.running} of your agents are running, the limit of deliver.maxParallel. Wait for one to finish, then run norn next ${r.story} again.`
      ),
      "",
      ...r.start.map((s) => `  - ${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}" ${DESCRIBE[s.state] ?? `is in ${s.state}`}.`)
    );
  } else {
    const attendedOnly = r.start.every((s) => s.attended);
    const count = `You can start ${r.start.length} item${r.start.length === 1 ? "" : "s"} now`;
    const agent = {
      herdr: "each as a new herdr agent in the item's worktree pane:",
      "claude-code": "each in its own fresh subagent, told to work in the item's worktree:",
      git: "each in a new agent session started in the item's worktree:"
    }[r.provider];
    out.push(
      attendedOnly ? `${count}, with the user:` : r.start.length === 1 ? `${count}, ${agent.replace(/^each /, "")}` : wrap(`${count}. They are independent, so run them in parallel, at most ${r.slots} at a time${runningNote(r)}, ${agent}`),
      ""
    );
    for (const s of r.start) {
      const what = `${s.kind === "slice" ? "Slice" : "Story"} #${s.issue} "${s.title}"`;
      const desc = s.kind === "story" && !DESCRIBE[s.state] ? `is in ${s.state}: ${s.step}${s.attended ? " (attended: the user takes part)" : ""}.` : `${DESCRIBE[s.state] ?? `is in ${s.state}`}${s.attended ? " (attended: the user takes part)" : ""}.`;
      out.push(`  - ${what} ${desc}`);
      if (s.worktree) out.push(`    Worktree: ${s.worktree}`);
      if (s.createWorktree) out.push(`    Create the worktree: ${s.createWorktree}`);
      if (s.checkedOutAt && s.branch) out.push(`    ${checkedOutElsewhere(s.branch, s.checkedOutAt)}`);
      if (r.provider === "herdr" && s.worktree) {
        const start = `herdr agent start norn-${s.issue} --kind claude --pane <pane of ${s.worktree}>`;
        if (!s.attended) {
          const prompt = `Work in ${s.worktree}. Run norn take ${s.issue}, follow its briefing to the end, and finish with the norn command it gives.`;
          out.push(`    Start an agent: ${start}`, `    Then prompt it: herdr agent prompt norn-${s.issue} "${prompt}"`);
        } else if (s.here) out.push("    You are in its worktree: take it in this session.");
        else {
          out.push(
            "    Hand the story to an agent in its worktree, which drives it on with the user:",
            `      ${start}`,
            `      herdr agent prompt norn-${s.issue} "norn-drive ${r.story}"`,
            `      herdr agent focus norn-${s.issue}`
          );
        }
      }
      if (s.session && s.worktree) out.push(`    Start an agent in ${s.worktree} with NORN_SESSION=${s.session} set.`);
      out.push(`    Start it with: ${s.command}`);
    }
  }
  if (r.waiting.length) {
    out.push("", "Waiting, nothing to do for you:");
    for (const w of r.waiting) out.push(waitLine(w), ...humanHandOff(w));
  }
  if (r.start.some((s) => !s.attended)) out.push("", `Each phase gets a new agent. When an item is done, run norn next ${r.story} again.`);
  return out.join("\n");
}
function renderNotification(n) {
  switch (n.kind) {
    case "needs-human":
      return { title: `norn: #${n.issue} needs you`, body: `${n.reason}
${n.url}` };
    case "needs-human-qa":
      return { title: `norn: #${n.issue} needs you`, body: `needs human QA (${n.of})
${n.url}` };
    case "story-waiting":
      return {
        title: `norn: story #${n.story} is waiting for you`,
        body: n.waiting.map((w) => `#${w.issue} ${waitDetail(w)}`).join("\n") || "Nothing left to do on the story."
      };
    default:
      return unreachable(n);
  }
}

// packages/cli/src/render-json.ts
function renderJson(answer, warnings) {
  const body = answer.ok ? { ok: true, ...data(answer), message: renderAnswer(answer).join("\n") } : { ok: false, refusal: renderRefusal(answer.refusal).join("\n") };
  return JSON.stringify(warnings.length ? { ...body, warnings: warnings.map(renderWarning) } : body, null, 2);
}
function data(a) {
  switch (a.kind) {
    case "taken":
      return { issue: a.issue, state: a.state, step: a.step.name, skill: a.step.skill, attended: a.step.attended, outcomes: a.step.outcomes };
    case "done":
      return { issue: a.issue, from: a.from, to: a.to, ...a.evidence ? { evidence: a.evidence } : {} };
    case "status":
      return { story: { ...row2(a.story), owner: a.story.owner, branch: a.story.branch }, slices: a.slices.map(row2) };
    case "tidy":
      return {
        dryRun: a.dryRun,
        removed: a.removed.map(renderRemoval),
        kept: a.kept.map(renderKept),
        failed: a.failed.map(renderFailure),
        notes: tidyNotes(a)
      };
    case "next":
      return { ...a.report, waiting: a.report.waiting.map(wait), notes: a.report.notes.flatMap(renderEvent) };
    case "dashboard":
      return a.launch.kind === "started" ? { url: a.launch.url, port: a.launch.port, intervalMs: a.intervalMs, opened: a.launch.opened } : { url: a.launch.url, alreadyRunning: true };
    case "escalated":
    case "released":
    case "slice-added":
    case "initialized":
      return {};
    default:
      return unreachable(a);
  }
}
function row2(r) {
  return {
    number: r.number,
    title: r.title,
    state: rowState(r),
    mode: r.mode,
    blockedBy: r.blockedBy,
    needsHuman: r.needsHuman,
    heldSince: r.heldSince,
    stale: r.stale
  };
}
function wait(w) {
  const base = { issue: w.issue, reason: w.reason, detail: waitDetail(w) };
  if (w.reason === "held") return { ...base, mine: w.holder.mine };
  if (w.reason !== "needs-human" && w.reason !== "human-qa") return base;
  if (w.heldBy) return { ...base, heldBy: holderText(w.heldBy) };
  if (w.branch === void 0) return base;
  return { ...base, branch: w.branch, worktree: w.worktree, createWorktree: w.createWorktree, checkedOutAt: w.checkedOutAt, here: w.here };
}

// packages/cli/src/cli.ts
async function run(argv, deps) {
  const { bools } = parseArgs(argv);
  const { answer, warnings } = await dispatch(argv, deps);
  const usage = ["usage", "needs-number", "bad-dashboard-flag"];
  const exitCode = answer.ok ? 0 : usage.includes(answer.refusal.kind) ? 2 : 1;
  const head = warnings.length ? ["norn warning:", ...warnings.map((w) => `  ${renderWarning(w)}`), ""] : [];
  const body = answer.ok ? renderAnswer(answer) : renderRefusal(answer.refusal);
  if (bools.has("json")) return { exitCode, stdout: renderJson(answer, warnings) };
  return { exitCode, stdout: [...head, ...body].join("\n") };
}
var USES_WORKTREES = /* @__PURE__ */ new Set(["take", "next", "done", "tidy"]);
var NO_NUMBER = /* @__PURE__ */ new Set(["init", "tidy", "dashboard"]);
var refused = (refusal) => ({ ok: false, refusal });
async function dispatch(argv, input) {
  const { positionals, flags, bools } = parseArgs(argv);
  const [cmd, ...rest] = positionals;
  if (!cmd || !(cmd in NEEDS_NUMBER || NO_NUMBER.has(cmd))) return { answer: refused({ kind: "usage" }), warnings: [] };
  if (cmd in NEEDS_NUMBER && !/^\d+$/.test(rest[0] ?? "")) return { answer: refused({ kind: "needs-number", command: cmd }), warnings: [] };
  if (cmd === "init") return { answer: await init(input), warnings: [] };
  const loaded = await loadConfig(input.workspace);
  if (!loaded.ok) return { answer: loaded, warnings: [] };
  const ctx = { ...input, config: loaded.config, slugs: /* @__PURE__ */ new Map() };
  const provider = USES_WORKTREES.has(cmd) ? providerRefusal(ctx.config, ctx.workspace.env) : null;
  const answer = provider ? refused(provider) : cmd === "dashboard" ? await dashboard({ ...ctx, dashboard: input.dashboard }, flags, bools) : await command(cmd, rest, flags, bools, ctx);
  return { answer, warnings: loaded.warnings };
}
async function command(cmd, rest, flags, bools, ctx) {
  const n = Number(rest[0]);
  switch (cmd) {
    case "status":
      return status(ctx, n);
    case "take":
      return take(ctx, n, { takeover: bools.has("takeover") });
    case "done":
      return done(ctx, n, { word: rest[1], note: rest[2], evidenceDir: flags.evidence?.[0] });
    case "tidy":
      return tidy(ctx, bools.has("dry-run"));
    case "escalate":
      return escalate(ctx, n, rest[1]);
    case "release":
      return release(ctx, n);
    case "next":
      return next(ctx, n);
    case "add-slice":
      return addSlice(ctx, n, { title: rest[1], mode: flags.mode?.[0], blockedBy: (flags["blocked-by"] ?? []).map(Number) });
  }
  return refused({ kind: "usage" });
}

// packages/cli/src/env.ts
function sessionId(env, hostname2, repoRoot) {
  if (env.NORN_SESSION) return env.NORN_SESSION;
  if (env.CLAUDE_CODE_SESSION_ID) return env.CLAUDE_CODE_SESSION_ID;
  if (env.HERDR_PANE_ID) return `herdr:${env.HERDR_PANE_ID}`;
  return `${hostname2}:${repoRoot}`;
}

// packages/github-gh/src/gh.ts
import { spawn } from "node:child_process";

// packages/github-gh/src/observe-work.ts
var TIMELINE_TYPES = [
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "ISSUE_COMMENT",
  "CLOSED_EVENT",
  "REOPENED_EVENT",
  "SUB_ISSUE_ADDED_EVENT",
  "CROSS_REFERENCED_EVENT",
  "RENAMED_TITLE_EVENT",
  "ASSIGNED_EVENT",
  "UNASSIGNED_EVENT"
].join(", ");
var TIMELINE_NODES = `pageInfo { hasNextPage endCursor }
    nodes {
      __typename
      ... on LabeledEvent { createdAt actor { login } label { name } }
      ... on UnlabeledEvent { createdAt actor { login } label { name } }
      ... on IssueComment { createdAt author { login } url body }
      ... on ClosedEvent { createdAt actor { login } }
      ... on ReopenedEvent { createdAt actor { login } }
      ... on SubIssueAddedEvent { createdAt actor { login } subIssue { number } }
      ... on CrossReferencedEvent {
        source { ... on PullRequest { number url headRefName baseRefName state createdAt mergedAt author { login } mergedBy { login } } }
      }
      ... on RenamedTitleEvent { createdAt actor { login } }
      ... on AssignedEvent { createdAt actor { login } }
      ... on UnassignedEvent { createdAt actor { login } }
    }`;
var FRAGMENTS = `fragment Item on Issue {
  id number title url state stateReason closedAt
  repository { url }
  labels(first: 30) { nodes { name } }
  blockedBy(first: 20) { nodes { number state } }
  timelineItems(first: 100, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_NODES} }
}
fragment Story on Issue {
  ...Item
  assignees(first: 5) { nodes { login } }
  subIssues(first: 20) { pageInfo { hasNextPage endCursor } nodes { ...Item } }
}`;
var STORIES = `query($owner: String!, $name: String!, $user: String!, $closedSince: DateTime!, $openAfter: String, $closedAfter: String) {
  repository(owner: $owner, name: $name) {
    url
    open: issues(first: 10, after: $openAfter, states: OPEN, labels: ["type:story"], filterBy: { assignee: $user }) {
      pageInfo { hasNextPage endCursor } nodes { ...Story }
    }
    closed: issues(first: 5, after: $closedAfter, states: CLOSED, labels: ["type:story"], filterBy: { assignee: $user, since: $closedSince }, orderBy: { field: UPDATED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor } nodes { ...Story }
    }
    __CLAIMS__
  }
}
${FRAGMENTS}`;
var MORE_TIMELINE = `query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { timelineItems(first: 100, after: $after, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_NODES} } } }
}`;
var MORE_SUB_ISSUES = `query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { subIssues(first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Item } } } }
}
${FRAGMENTS}`;
function parseLsRemote(out) {
  return out.split("\n").flatMap((line) => {
    const m = /^([0-9a-f]{40})\s+refs\/norn\/claims\/(\d+)$/.exec(line.trim());
    return m ? [{ issue: Number(m[2]), sha: m[1] }] : [];
  });
}
async function observeWork(graphql, lsRemote, query) {
  const refs = parseLsRemote(await lsRemote());
  const claimFields = refs.map((r, i) => `c${i}: object(oid: "${r.sha}") { ... on Commit { message } }`).join("\n    ");
  const text = STORIES.replace("__CLAIMS__", claimFields);
  const read2 = async (openAfter, closedAfter) => (await graphql(text, { user: query.user, closedSince: query.closedSince, openAfter, closedAfter })).data.repository;
  const first = await read2(null, null);
  const raws = [...first.open.nodes, ...first.closed.nodes];
  let { open, closed } = first;
  while (open.pageInfo?.hasNextPage || closed.pageInfo?.hasNextPage) {
    const next2 = await read2(open.pageInfo?.hasNextPage ? open.pageInfo.endCursor : null, closed.pageInfo?.hasNextPage ? closed.pageInfo.endCursor : null);
    if (open.pageInfo?.hasNextPage) raws.push(...next2.open.nodes);
    if (closed.pageInfo?.hasNextPage) raws.push(...next2.closed.nodes);
    open = open.pageInfo?.hasNextPage ? next2.open : { nodes: [] };
    closed = closed.pageInfo?.hasNextPage ? next2.closed : { nodes: [] };
  }
  const claims = refs.map((r, i) => ({ ...r, record: claimRecord(first[`c${i}`]) }));
  const repoUrl = first.url;
  const stories = [];
  for (const raw of raws) stories.push(await story(graphql, raw, repoUrl, query.since));
  const known = new Set(stories.flatMap((s) => [s.number, ...s.subIssues.map((i) => i.number)]));
  const outside = claims.filter((c) => c.record?.holder === query.user && !known.has(c.issue));
  if (outside.length) {
    const fields = outside.map((c, i) => `x${i}: issue(number: ${c.issue}) { ...Story parent { ...Story } }`).join("\n    ");
    const res = await graphql(
      `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ${fields}
  }
}
${FRAGMENTS}`,
      {}
    );
    for (const hit of Object.values(res.data.repository)) {
      const raw = hit?.labels.nodes.some((l) => l.name === "type:story") ? hit : hit?.parent;
      if (raw && !stories.some((s) => s.number === raw.number)) stories.push(await story(graphql, raw, repoUrl, query.since));
    }
  }
  return { repoUrl, stories, claims };
}
function claimRecord(object) {
  try {
    const r = JSON.parse(object.message);
    return typeof r.holder === "string" && typeof r.session === "string" && typeof r.since === "string" ? r : null;
  } catch {
    return null;
  }
}
async function story(graphql, raw, repoUrl, since) {
  const subs = [...raw.subIssues?.nodes ?? []];
  let page2 = raw.subIssues?.pageInfo;
  while (page2?.hasNextPage) {
    const res = await graphql(MORE_SUB_ISSUES, { id: raw.id, after: page2.endCursor });
    subs.push(...res.data.node.subIssues.nodes);
    page2 = res.data.node.subIssues.pageInfo;
  }
  const here = subs.filter((s) => s.repository.url === repoUrl);
  const subIssues = [];
  for (const s of here) subIssues.push(await issue(graphql, s, since));
  return { ...await issue(graphql, raw, since), subIssues };
}
async function issue(graphql, raw, since) {
  const events = [...raw.timelineItems.nodes];
  let page2 = raw.timelineItems.pageInfo;
  while (page2?.hasNextPage) {
    const res = await graphql(MORE_TIMELINE, { id: raw.id, after: page2.endCursor });
    events.push(...res.data.node.timelineItems.nodes);
    page2 = res.data.node.timelineItems.pageInfo;
  }
  const timeline = [];
  const pullRequests = /* @__PURE__ */ new Map();
  for (const e of events) {
    if (e.__typename === "CrossReferencedEvent") {
      const pr = e.source;
      if (pr?.number !== void 0) pullRequests.set(pr.number, toPr(pr));
      continue;
    }
    const item = toItem(e);
    if (item) timeline.push(item);
  }
  const labels = raw.labels.nodes.map((l) => l.name);
  const observed = {
    number: raw.number,
    title: raw.title,
    state: raw.state === "OPEN" ? "open" : "closed",
    labels,
    assignees: raw.assignees?.nodes.map((a) => a.login) ?? [],
    url: raw.url,
    closedAt: raw.closedAt,
    blockedBy: raw.blockedBy.nodes.map((b) => ({ number: b.number, state: b.state === "OPEN" ? "open" : "closed" })),
    nornComments: timeline.flatMap((t) => t.kind === "comment" && t.body !== null ? [{ body: t.body, at: t.at, actor: t.actor, url: t.url }] : []),
    pullRequests: [...pullRequests.values()],
    timeline: timeline.filter((t) => since === null || t.at > since)
  };
  if (raw.stateReason === "COMPLETED") observed.stateReason = "completed";
  if (raw.stateReason === "NOT_PLANNED") observed.stateReason = "not_planned";
  return observed;
}
function toPr(pr) {
  return {
    number: pr.number,
    url: pr.url,
    head: pr.headRefName,
    base: pr.baseRefName,
    state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed",
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: pr.author?.login ?? null,
    mergedBy: pr.mergedBy?.login ?? null
  };
}
function toItem(e) {
  const at = e.createdAt ?? "";
  const actor = (e.actor ?? e.author)?.login ?? null;
  switch (e.__typename) {
    case "LabeledEvent":
    case "UnlabeledEvent":
      return e.label ? { kind: e.__typename === "LabeledEvent" ? "labeled" : "unlabeled", label: e.label.name, at, actor } : null;
    case "IssueComment":
      return { kind: "comment", at, actor, url: e.url ?? "", body: e.body !== void 0 && isNornComment(e.body) ? e.body : null };
    case "ClosedEvent":
      return { kind: "closed", at, actor };
    case "ReopenedEvent":
      return { kind: "reopened", at, actor };
    case "SubIssueAddedEvent":
      return e.subIssue ? { kind: "sub-issue-added", child: e.subIssue.number, at, actor } : null;
    default:
      return { kind: "other", at, actor, url: null, detail: e.__typename };
  }
}

// packages/github-gh/src/gh.ts
var spawnExec = (program) => (args, input) => new Promise((resolve2, reject) => {
  const child = spawn(program, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  child.on("error", reject);
  child.on("close", (code) => resolve2({ code: code ?? 1, stdout, stderr }));
  child.stdin.end(input ?? "");
});
var execGit = spawnExec("git");
var execGh = (args, input) => new Promise((resolve2, reject) => {
  const child = spawn("gh", args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  child.on("error", reject);
  child.on("close", (code) => resolve2({ code: code ?? 1, stdout, stderr }));
  child.stdin.end(input ?? "");
});
var GhError = class extends Error {
  constructor(args, stderr) {
    super(`gh ${args.join(" ")} failed: ${stderr.trim()}`);
    this.args = args;
    this.stderr = stderr;
  }
  get status() {
    const m = /HTTP (\d{3})/.exec(this.stderr);
    return m ? Number(m[1]) : null;
  }
};
function ghFailure(e) {
  const text = e instanceof GhError ? e.stderr : e instanceof Error ? e.message : String(e);
  const status2 = e instanceof GhError ? e.status : null;
  if (status2 === 401 || /gh auth login|authentication|Bad credentials/i.test(text)) return "auth";
  if (/rate limit/i.test(text) || status2 === 429) return "rate-limit";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|could not resolve|connection|network/i.test(text)) return "network";
  return "other";
}
var REPO = "repos/{owner}/{repo}";
function toIssue(r) {
  const issue2 = {
    number: r.number,
    title: r.title,
    state: r.state,
    labels: r.labels.map((l) => l.name),
    assignees: r.assignees.map((a) => a.login)
  };
  if (r.state_reason === "completed" || r.state_reason === "not_planned") issue2.stateReason = r.state_reason;
  return issue2;
}
var GhGitHub = class {
  constructor(exec = execGh, git = execGit) {
    this.exec = exec;
    this.git = git;
  }
  async gh(args, input) {
    const r = await this.exec(args, input);
    if (r.code !== 0) throw new GhError(args, r.stderr);
    return r.stdout;
  }
  async api(method, path, body) {
    const args = ["api", "-X", method, path];
    if (body !== void 0) args.push("--input", "-");
    const out = await this.gh(args, body === void 0 ? void 0 : JSON.stringify(body));
    return out.trim() ? JSON.parse(out) : null;
  }
  /** Like api, but a 404 gives null. */
  async find(path) {
    try {
      return await this.api("GET", path);
    } catch (e) {
      if (e instanceof GhError && e.status === 404) return null;
      throw e;
    }
  }
  async rawIssue(n) {
    return this.api("GET", `${REPO}/issues/${n}`);
  }
  async currentUser() {
    return (await this.api("GET", "user")).login;
  }
  async repoUrl() {
    return (await this.api("GET", REPO)).html_url;
  }
  async defaultBranch() {
    return (await this.api("GET", REPO)).default_branch;
  }
  async getIssue(n) {
    return toIssue(await this.rawIssue(n));
  }
  async addLabels(n, labels) {
    await this.api("POST", `${REPO}/issues/${n}/labels`, { labels });
  }
  async removeLabels(n, labels) {
    for (const l of labels) {
      try {
        await this.api("DELETE", `${REPO}/issues/${n}/labels/${encodeURIComponent(l)}`);
      } catch (e) {
        if (!(e instanceof GhError && e.status === 404)) throw e;
      }
    }
  }
  async assign(n, users) {
    await this.api("POST", `${REPO}/issues/${n}/assignees`, { assignees: users });
  }
  async comment(n, body) {
    await this.api("POST", `${REPO}/issues/${n}/comments`, { body });
  }
  async listComments(n) {
    return (await this.paginate(`${REPO}/issues/${n}/comments`)).map((c) => c.body);
  }
  async closeIssue(n, reason) {
    await this.api("PATCH", `${REPO}/issues/${n}`, { state: "closed", state_reason: reason });
  }
  async createIssue(input) {
    return toIssue(await this.api("POST", `${REPO}/issues`, input));
  }
  async addSubIssue(parent, child) {
    const { id } = await this.rawIssue(child);
    await this.api("POST", `${REPO}/issues/${parent}/sub_issues`, { sub_issue_id: id });
  }
  async subIssues(parent) {
    const all = await this.paginate(`${REPO}/issues/${parent}/sub_issues`);
    if (all.length === 0) return [];
    const { url } = await this.api("GET", REPO);
    return all.filter((r) => !r.repository_url || r.repository_url === url).map(toIssue);
  }
  async parentOf(child) {
    const p = await this.find(`${REPO}/issues/${child}/parent`);
    return p ? p.number : null;
  }
  async addBlockedBy(n, blocker) {
    const { id } = await this.rawIssue(blocker);
    await this.api("POST", `${REPO}/issues/${n}/dependencies/blocked_by`, { issue_id: id });
  }
  async blockedBy(n) {
    return (await this.paginate(`${REPO}/issues/${n}/dependencies/blocked_by`)).map(toIssue);
  }
  /**
   * Every element of a paged list. `--jq '.[]'` prints one compact JSON value
   * per line across all pages; unlike `--slurp` (gh 2.48+), it works on the
   * older gh that distributions ship.
   */
  async paginate(path) {
    const out = await this.gh(["api", "--paginate", "--jq", ".[]", path]);
    return out.split("\n").filter((line) => line.trim()).map((line) => JSON.parse(line));
  }
  async ensureLabels(labels) {
    for (const l of labels) {
      await this.gh(["label", "create", l.name, "--color", l.color, "--description", l.description, "--force"]);
    }
  }
  async branchExists(name) {
    return await this.find(`${REPO}/git/ref/heads/${name}`) !== null;
  }
  async listBranches(prefix) {
    const refs = await this.paginate(`${REPO}/git/matching-refs/${`heads/${prefix}`.replace(/\/+$/, "")}`);
    return refs.map((r) => r.ref.slice("refs/heads/".length)).filter((b) => b.startsWith(prefix));
  }
  async deleteBranch(name) {
    try {
      await this.api("DELETE", `${REPO}/git/refs/heads/${name}`);
    } catch (e) {
      if (!(e instanceof GhError && (e.status === 404 || e.status === 422))) throw e;
    }
  }
  async pushFiles(branch, files2, message) {
    const tree = [];
    for (const f of files2) {
      const blob = await this.api("POST", `${REPO}/git/blobs`, { content: f.content.toString("base64"), encoding: "base64" });
      tree.push({ path: f.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const t = await this.api("POST", `${REPO}/git/trees`, { tree });
    const head = await this.find(`${REPO}/git/ref/heads/${branch}`);
    const commit = await this.api("POST", `${REPO}/git/commits`, {
      message,
      tree: t.sha,
      parents: head ? [head.object.sha] : []
    });
    if (head) await this.api("PATCH", `${REPO}/git/refs/heads/${branch}`, { sha: commit.sha, force: false });
    else await this.api("POST", `${REPO}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
    return commit.sha;
  }
  async createBranch(name, from) {
    const head = await this.api("GET", `${REPO}/git/ref/heads/${from}`);
    await this.api("POST", `${REPO}/git/refs`, { ref: `refs/heads/${name}`, sha: head.object.sha });
  }
  async findPullRequest(head) {
    const out = await this.gh([
      "pr",
      "list",
      "--head",
      head,
      "--state",
      "all",
      "--limit",
      "1",
      "--json",
      "number,headRefName,baseRefName,state,body,headRefOid"
    ]);
    const [pr] = JSON.parse(out);
    if (!pr) return null;
    return {
      number: pr.number,
      head: pr.headRefName,
      base: pr.baseRefName,
      state: pr.state.toLowerCase(),
      body: pr.body,
      ...pr.headRefOid ? { headSha: pr.headRefOid } : {}
    };
  }
  async createPullRequest(input) {
    const pr = await this.api("POST", `${REPO}/pulls`, input);
    return { number: pr.number, head: input.head, base: input.base, state: "open", body: input.body };
  }
  /** A commit whose message and claim.json are the record; parentless for a new claim. */
  async claimCommit(record, parents = []) {
    const content = JSON.stringify(record);
    const tree = await this.api("POST", `${REPO}/git/trees`, {
      tree: [{ path: "claim.json", mode: "100644", type: "blob", content }]
    });
    const commit = await this.api("POST", `${REPO}/git/commits`, {
      message: content,
      tree: tree.sha,
      parents
    });
    return commit.sha;
  }
  async replaceClaim(n, fromSha, record) {
    const sha = await this.claimCommit(record, [fromSha]);
    try {
      await this.api("PATCH", `${REPO}/git/refs/norn/claims/${n}`, { sha, force: false });
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 422) return false;
      throw e;
    }
  }
  async createClaim(n, record) {
    const sha = await this.claimCommit(record);
    try {
      await this.api("POST", `${REPO}/git/refs`, { ref: `refs/norn/claims/${n}`, sha });
      return true;
    } catch (e) {
      if (e instanceof GhError && e.status === 422) return false;
      throw e;
    }
  }
  async readClaim(n) {
    const ref = await this.find(`${REPO}/git/ref/norn/claims/${n}`);
    if (!ref) return null;
    const commit = await this.api("GET", `${REPO}/git/commits/${ref.object.sha}`);
    return { ...JSON.parse(commit.message), sha: ref.object.sha };
  }
  async listClaims() {
    const refs = await this.paginate(`${REPO}/git/matching-refs/norn/claims`);
    return refs.map((r) => /^refs\/norn\/claims\/(\d+)$/.exec(r.ref)).filter((m) => m !== null).map((m) => Number(m[1]));
  }
  async deleteClaim(n) {
    try {
      await this.api("DELETE", `${REPO}/git/refs/norn/claims/${n}`);
    } catch (e) {
      if (!(e instanceof GhError && (e.status === 404 || e.status === 422))) throw e;
    }
  }
  async observeWork(query) {
    const graphql = async (text, vars) => {
      const args = ["api", "graphql", "-F", "owner={owner}", "-F", "name={repo}", "-f", `query=${text}`];
      for (const [k, v] of Object.entries(vars)) if (v !== null) args.push(typeof v === "number" ? "-F" : "-f", `${k}=${v}`);
      return JSON.parse(await this.gh(args));
    };
    const lsRemote = async () => {
      const args = ["ls-remote", "origin", "refs/norn/claims/*"];
      const r = await this.git(args);
      if (r.code !== 0) throw new GhError(["(git)", ...args], r.stderr);
      return r.stdout;
    };
    return observeWork(graphql, lsRemote, query);
  }
};

// packages/cli/src/install-skills.ts
import { spawnSync } from "node:child_process";
import { cpSync, existsSync as existsSync2, readdirSync as readdirSync2, readFileSync as readFileSync2, rmSync, statSync } from "node:fs";
import { dirname, join as join5, relative as relative2 } from "node:path";
import { fileURLToPath } from "node:url";
var BUNDLED_SKILLS = findSkills(dirname(fileURLToPath(import.meta.url)));
function findSkills(from) {
  for (let dir = from; ; dir = dirname(dir)) {
    const manifest = join5(dir, "package.json");
    if (existsSync2(manifest) && JSON.parse(readFileSync2(manifest, "utf8")).name === "norn") return join5(dir, "skills");
    if (dirname(dir) === dir) return join5(from, "..", "skills");
  }
}
async function installSkills(cwd, env = process.env) {
  const source = env.NORN_SKILLS_SOURCE;
  if (source) {
    const r = spawnSync("npx", ["-y", "skills", "add", source], { cwd, stdio: "inherit" });
    if (r.status !== 0) process.stderr.write(`npx skills add ${source} failed; using the skills bundled with norn.
`);
  }
  const updated = [];
  for (const name of readdirSync2(BUNDLED_SKILLS)) {
    const bundled = join5(BUNDLED_SKILLS, name);
    const target = join5(cwd, "skills", name);
    if (existsSync2(join5(target, "SKILL.md"))) {
      if (source || sameTree(bundled, target)) continue;
      rmSync(target, { recursive: true, force: true });
      updated.push(name);
    }
    cpSync(bundled, target, { recursive: true });
  }
  return updated;
}
function sameTree(a, b) {
  const fa = files(a);
  const fb = files(b);
  return fa.length === fb.length && fa.every((f, i) => f === fb[i] && readFileSync2(join5(a, f)).equals(readFileSync2(join5(b, f))));
}
function files(dir, root = dir) {
  return readdirSync2(dir).sort().flatMap((e) => statSync(join5(dir, e)).isDirectory() ? files(join5(dir, e), root) : [relative2(root, join5(dir, e))]);
}

// packages/workspace-local/src/local-workspace.ts
import { spawn as spawn2 } from "node:child_process";
import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname as dirname2, join as join6, relative as relative3, resolve, sep } from "node:path";
var runCommand = (cmd, args, env) => new Promise((resolve2, reject) => {
  const child = spawn2(cmd, args, { stdio: ["ignore", "pipe", "pipe"], env: env ? { ...process.env, ...env } : process.env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => stdout += d);
  child.stderr.on("data", (d) => stderr += d);
  child.on("error", reject);
  child.on("close", (code) => resolve2({ code: code ?? 1, stdout, stderr }));
});
var RootError = class extends Error {
};
var LocalWorkspace = class {
  constructor(root, env, run2 = runCommand, cwd = root) {
    this.root = root;
    this.env = env;
    this.run = run2;
    this.cwd = cwd;
  }
  /**
   * The main checkout's root, also from inside a linked worktree. The parent of
   * the git directory is only right for an ordinary .git: a submodule's lives in
   * the superproject's .git/modules and records its checkout as core.worktree.
   * git worktree list names the git directory itself in those layouts, so it
   * cannot be used either.
   */
  static async findRoot(cwd, run2 = runCommand) {
    const r = await run2("git", ["-C", cwd, "rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--show-toplevel"]);
    if (r.code !== 0) throw new RootError(`Not inside a git repository's checkout: ${cwd}`);
    const [gitDir, commonDir, toplevel] = r.stdout.trim().split("\n");
    if (gitDir === commonDir) return toplevel;
    const configured = await run2("git", ["--git-dir", commonDir, "config", "--get", "core.worktree"]);
    if (configured.code === 0 && configured.stdout.trim()) return resolve(commonDir, configured.stdout.trim());
    if (basename(commonDir) === ".git") return dirname2(commonDir);
    throw new RootError(`Cannot find the main checkout of ${commonDir} from this worktree. Run norn from the main checkout.`);
  }
  async must(cmd, args) {
    const r = await this.run(cmd, args);
    if (r.code !== 0) throw new Error(`${cmd} ${args.join(" ")} failed: ${r.stderr.trim()}`);
    return r.stdout;
  }
  async readFile(rel) {
    try {
      return await readFile(join6(this.root, rel), "utf8");
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
  }
  async worktreeExists(rel) {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    const path = join6(this.root, rel);
    return out.split("\n").some((l) => l.startsWith("worktree ") && samePath(l.slice("worktree ".length), path));
  }
  async branchCheckedOutAt(branch) {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    for (const entry of out.split("\n\n")) {
      const lines = entry.split("\n");
      if (lines.includes(`branch refs/heads/${branch}`)) {
        return lines.find((l) => l.startsWith("worktree "))?.slice("worktree ".length) ?? null;
      }
    }
    return null;
  }
  async worktreeDirty(rel) {
    return (await this.must("git", ["-C", join6(this.root, rel), "status", "--porcelain"])).trim() !== "";
  }
  async localBranchExists(branch) {
    return (await this.run("git", ["-C", this.root, "show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
  }
  async listWorktrees() {
    const out = await this.must("git", ["-C", this.root, "worktree", "list", "--porcelain"]);
    return out.split("\n\n").map((entry) => entry.split("\n")).filter((lines) => lines[0]?.startsWith("worktree ")).map((lines) => ({
      path: lines[0].slice("worktree ".length),
      branch: lines.find((l) => l.startsWith("branch refs/heads/"))?.slice("branch refs/heads/".length) ?? null
    }));
  }
  async listLocalBranches() {
    const out = await this.must("git", ["-C", this.root, "for-each-ref", "--format=%(refname:short)", "refs/heads/"]);
    return out.split("\n").filter(Boolean);
  }
  async branchHead(branch) {
    const r = await this.run("git", ["-C", this.root, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async hasUnpushedCommits(branch) {
    const out = await this.must("git", ["-C", this.root, "rev-list", "--count", `refs/heads/${branch}`, "--not", "--remotes"]);
    return Number(out.trim()) > 0;
  }
  async deleteLocalBranch(branch) {
    await this.must("git", ["-C", this.root, "branch", "-D", branch]);
  }
  async fetchRemote() {
    await this.must("git", ["-C", this.root, "fetch", "--prune", "origin"]);
  }
  async readEvidence(dir) {
    const abs = resolve(this.cwd, dir);
    try {
      if (!(await stat(abs)).isDirectory()) return null;
    } catch (e) {
      if (e.code === "ENOENT") return null;
      throw e;
    }
    const files2 = [];
    const walk = async (d) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const full = join6(d, e.name);
        if (e.isDirectory()) await walk(full);
        else if (e.isFile()) files2.push({ path: relative3(abs, full).split(sep).join("/"), content: await readFile(full) });
      }
    };
    await walk(abs);
    return files2.sort((a, b) => a.path.localeCompare(b.path));
  }
  async removeWorktree(rel, provider) {
    const path = join6(this.root, rel);
    if (provider === "herdr") {
      const list = JSON.parse(await this.must("herdr", ["worktree", "list", "--cwd", this.root]));
      const id = list.result.worktrees.find((w) => samePath(w.path, path))?.open_workspace_id;
      if (id) {
        await this.must("herdr", ["worktree", "remove", "--workspace", id, "--force"]);
        return;
      }
    }
    await this.must("git", ["-C", this.root, "worktree", "remove", "--force", path]);
  }
};

// packages/workspace-local/src/notifier.ts
var appleScriptString = (s) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
function osCommand(platform, { title, body }) {
  if (platform === "darwin") {
    return ["osascript", ["-e", `display notification ${appleScriptString(body)} with title ${appleScriptString(title)}`]];
  }
  if (platform === "win32") {
    const script = [
      "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null",
      "$xml = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
      "$text = $xml.GetElementsByTagName('text')",
      "$text.Item(0).AppendChild($xml.CreateTextNode($env:NORN_TITLE)) | Out-Null",
      "$text.Item(1).AppendChild($xml.CreateTextNode($env:NORN_BODY)) | Out-Null",
      "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('norn').Show([Windows.UI.Notifications.ToastNotification]::new($xml))"
    ].join("; ");
    return ["powershell", ["-NoProfile", "-Command", script], { NORN_TITLE: title, NORN_BODY: body }];
  }
  return ["notify-send", [title, body]];
}
function makeNotifier(platform = process.platform, run2 = runCommand) {
  return async (channel, message) => {
    const [cmd, args, env] = channel === "herdr" ? ["herdr", ["notification", "show", message.title, "--body", message.body, "--sound", "request"]] : osCommand(platform, message);
    const r = await run2(cmd, args, env);
    if (r.code !== 0) throw new Error(`${cmd} failed: ${r.stderr.trim()}`);
  };
}

// packages/web/src/server.ts
import { createServer } from "node:http";

// packages/web/src/icon.ts
var ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 280 280" role="img" aria-label="Norn">
  <rect width="280" height="280" rx="64" fill="#14182E"/>
  <path d="M 66 214 V 140 A 74 74 0 0 1 214 140 V 214" fill="none" stroke="#E8B44A" stroke-width="14" stroke-linecap="round"/>
  <path d="M 88 214 V 140 A 52 52 0 0 1 192 140 V 214" fill="none" stroke="#F3DCA6" stroke-width="14" stroke-linecap="round"/>
  <path d="M 110 214 V 140 A 30 30 0 0 1 170 140 V 214" fill="none" stroke="#C8862A" stroke-width="14" stroke-linecap="round"/>
</svg>
`;

// packages/web/src/server.ts
var PORTS_TRIED = 20;
var OVERLAP_MS = 6e4;
async function serveDashboard(deps, at) {
  const poller = new Poller(deps);
  const server = createServer((req, res) => {
    handle(req, res, deps, poller).catch((e) => {
      res.writeHead(500, { "content-type": "text/plain" }).end(String(e));
    });
  });
  const tries = at.explicit || at.port === 0 ? 1 : PORTS_TRIED;
  for (let port = at.port; port < at.port + tries; port++) {
    const bound = await listen(server, port);
    if (bound !== null) {
      const url = `http://127.0.0.1:${bound}`;
      poller.start();
      return {
        kind: "started",
        dashboard: {
          url,
          port: bound,
          idle: () => poller.idle(),
          close: async () => {
            poller.stop();
            await poller.idle();
            await new Promise((r) => server.close(() => r()));
          }
        }
      };
    }
    const running = `http://127.0.0.1:${port}`;
    if (await sameCheckout(running, deps.root)) return { kind: "already-running", url: running };
    if (at.explicit) return { kind: "port-taken", port };
  }
  return { kind: "port-taken", port: at.port };
}
function listen(server, port) {
  return new Promise((resolve2, reject) => {
    const failed = (e) => {
      server.off("listening", bound);
      if (e.code === "EADDRINUSE" || e.code === "EACCES") resolve2(null);
      else reject(e);
    };
    const bound = () => {
      server.off("error", failed);
      resolve2(server.address().port);
    };
    server.once("error", failed);
    server.once("listening", bound);
    server.listen(port, "127.0.0.1");
  });
}
async function sameCheckout(url, root) {
  try {
    const res = await fetch(`${url}/api/identity`, { signal: AbortSignal.timeout(1500) });
    const id = await res.json();
    return id.app === "norn-dashboard" && id.root === root;
  } catch {
    return false;
  }
}
async function handle(req, res, deps, poller) {
  const path = (req.url ?? "/").split("?")[0];
  const get = req.method === "GET" || req.method === "HEAD";
  const json = (body) => res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(JSON.stringify(body));
  if (get && path === "/api/state") return json(poller.state());
  if (req.method === "POST" && path === "/api/refresh") {
    await poller.refresh();
    return json(poller.state());
  }
  if (get && path === "/api/identity") return json({ app: "norn-dashboard", root: deps.root });
  if (get && path === "/") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page(deps.assets));
  if (get && path === "/favicon.svg") return res.writeHead(200, { "content-type": "image/svg+xml" }).end(ICON_SVG);
  if (get && deps.assets && path === "/assets/app.js") {
    return res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" }).end(deps.assets.js);
  }
  if (get && deps.assets && path === "/assets/app.css") {
    return res.writeHead(200, { "content-type": "text/css; charset=utf-8" }).end(deps.assets.css);
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("Not found");
}
function page(assets) {
  const body = assets ? '<div id="root"></div>\n<script type="module" src="/assets/app.js"></script>' : "<p>The dashboard UI is not built. Run <code>npm run build</code> and start it again.</p>";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>norn dashboard</title>
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
${assets ? '<link rel="stylesheet" href="/assets/app.css">' : ""}
</head>
<body>
${body}
</body>
</html>
`;
}
var Poller = class {
  constructor(deps) {
    this.deps = deps;
  }
  last = null;
  feed = [];
  lastError = null;
  loading = true;
  running = null;
  cancel = null;
  nextAt = null;
  stopped = false;
  start() {
    void this.refresh();
  }
  stop() {
    this.stopped = true;
    this.cancel?.();
  }
  idle() {
    return this.running ?? Promise.resolve();
  }
  refresh() {
    this.running ??= this.poll().finally(() => {
      this.running = null;
    });
    return this.running;
  }
  async poll() {
    this.cancel?.();
    this.cancel = null;
    this.nextAt = null;
    const { ctx } = this.deps;
    try {
      const prev = this.last;
      const since = prev ? new Date(Date.parse(prev.at) - OVERLAP_MS).toISOString() : null;
      const now = await observe(ctx, { since, previous: prev });
      const items = new Set(now.board.flatMap((s) => [s.number, ...s.slices.map((i) => i.number)]));
      const seen = new Set(now.feed.map((e) => e.id));
      this.feed = byTime([...now.feed, ...this.feed.filter((e) => !seen.has(e.id))]).filter((e) => items.has(e.issue));
      this.last = now;
      this.lastError = null;
    } catch (e) {
      this.lastError = { at: ctx.now().toISOString(), reason: this.deps.failure(e), detail: e instanceof Error ? e.message : String(e) };
    }
    this.loading = false;
    if (this.stopped) return;
    const schedule = this.deps.schedule ?? ((fn, ms) => clearer(setTimeout(fn, ms)));
    this.cancel = schedule(() => void this.refresh(), this.deps.intervalMs);
    this.nextAt = new Date(ctx.now().getTime() + this.deps.intervalMs).toISOString();
  }
  state() {
    const { last } = this;
    return {
      status: this.loading ? "loading" : "ready",
      me: last?.me ?? null,
      repoUrl: last?.repoUrl ?? null,
      board: last?.board ?? [],
      waiting: last?.waiting ?? [],
      feed: this.feed,
      lastUpdated: last?.at ?? null,
      lastError: this.lastError,
      intervalMs: this.deps.intervalMs,
      nextPoll: this.nextAt,
      now: this.deps.ctx.now().toISOString()
    };
  }
};
function clearer(timer) {
  timer.unref();
  return () => clearTimeout(timer);
}

// packages/web/src/ui-assets.ts
async function uiAssets() {
  return { js: 'var e=(e,t)=>()=>(t||(e((t={exports:{}}).exports,t,t.exports),e=null),t.exports),t=e((e=>{var t=Symbol.for(`react.transitional.element`),n=Symbol.for(`react.portal`),r=Symbol.for(`react.fragment`),i=Symbol.for(`react.strict_mode`),a=Symbol.for(`react.profiler`),o=Symbol.for(`react.consumer`),s=Symbol.for(`react.context`),c=Symbol.for(`react.forward_ref`),l=Symbol.for(`react.suspense`),u=Symbol.for(`react.memo`),d=Symbol.for(`react.lazy`),f=Symbol.for(`react.activity`),p=Symbol.for(`react.view_transition`),m=Symbol.iterator;function h(e){return typeof e!=`object`||!e?null:(e=m&&e[m]||e[`@@iterator`],typeof e==`function`?e:null)}var g={isMounted:function(){return!1},enqueueForceUpdate:function(){},enqueueReplaceState:function(){},enqueueSetState:function(){}},_=Object.assign,v={};function y(e,t,n){this.props=e,this.context=t,this.refs=v,this.updater=n||g}y.prototype.isReactComponent={},y.prototype.setState=function(e,t){if(typeof e!=`object`&&typeof e!=`function`&&e!=null)throw Error(`takes an object of state variables to update or a function which returns an object of state variables.`);this.updater.enqueueSetState(this,e,t,`setState`)},y.prototype.forceUpdate=function(e){this.updater.enqueueForceUpdate(this,e,`forceUpdate`)};function b(){}b.prototype=y.prototype;function ee(e,t,n){this.props=e,this.context=t,this.refs=v,this.updater=n||g}var te=ee.prototype=new b;te.constructor=ee,_(te,y.prototype),te.isPureReactComponent=!0;var ne=Array.isArray;function x(){}var S={H:null,A:null,T:null,S:null},re=Object.prototype.hasOwnProperty;function C(e,n,r){var i=r.ref;return{$$typeof:t,type:e,key:n,ref:i===void 0?null:i,props:r}}function ie(e,t){return C(e.type,t,e.props)}function ae(e){return typeof e==`object`&&!!e&&e.$$typeof===t}function oe(e){var t={"=":`=0`,":":`=2`};return`$`+e.replace(/[=:]/g,function(e){return t[e]})}var se=/\\/+/g;function ce(e,t){return typeof e==`object`&&e&&e.key!=null?oe(``+e.key):t.toString(36)}function le(e){switch(e.status){case`fulfilled`:return e.value;case`rejected`:throw e.reason;default:switch(typeof e.status==`string`?e.then(x,x):(e.status=`pending`,e.then(function(t){e.status===`pending`&&(e.status=`fulfilled`,e.value=t)},function(t){e.status===`pending`&&(e.status=`rejected`,e.reason=t)})),e.status){case`fulfilled`:return e.value;case`rejected`:throw e.reason}}throw e}function ue(e,r,i,a,o){var s=typeof e;(s===`undefined`||s===`boolean`)&&(e=null);var c=!1;if(e===null)c=!0;else switch(s){case`bigint`:case`string`:case`number`:c=!0;break;case`object`:switch(e.$$typeof){case t:case n:c=!0;break;case d:return c=e._init,ue(c(e._payload),r,i,a,o)}}if(c)return o=o(e),c=a===``?`.`+ce(e,0):a,ne(o)?(i=``,c!=null&&(i=c.replace(se,`$&/`)+`/`),ue(o,r,i,``,function(e){return e})):o!=null&&(ae(o)&&(o=ie(o,i+(o.key==null||e&&e.key===o.key?``:(``+o.key).replace(se,`$&/`)+`/`)+c)),r.push(o)),1;c=0;var l=a===``?`.`:a+`:`;if(ne(e))for(var u=0;u<e.length;u++)a=e[u],s=l+ce(a,u),c+=ue(a,r,i,s,o);else if(u=h(e),typeof u==`function`)for(e=u.call(e),u=0;!(a=e.next()).done;)a=a.value,s=l+ce(a,u++),c+=ue(a,r,i,s,o);else if(s===`object`){if(typeof e.then==`function`)return ue(le(e),r,i,a,o);throw r=String(e),Error(`Objects are not valid as a React child (found: `+(r===`[object Object]`?`object with keys {`+Object.keys(e).join(`, `)+`}`:r)+`). If you meant to render a collection of children, use an array instead.`)}return c}function de(e,t,n){if(e==null)return e;var r=[],i=0;return ue(e,r,``,``,function(e){return t.call(n,e,i++)}),r}function w(e){if(e._status===-1){var t=e._result,n=t();n.then(function(t){(e._status===0||e._status===-1)&&(e._status=1,e._result=t,n.status===void 0&&(n.status=`fulfilled`,n.value=t))},function(t){(e._status===0||e._status===-1)&&(e._status=2,e._result=t,n.status===void 0&&(n.status=`rejected`,n.reason=t))}),e._status===-1&&(e._status=0,e._result=n)}if(e._status===1)return e._result.default;throw e._result}var fe=typeof reportError==`function`?reportError:function(e){if(typeof window==`object`&&typeof window.ErrorEvent==`function`){var t=new window.ErrorEvent(`error`,{bubbles:!0,cancelable:!0,message:typeof e==`object`&&e&&typeof e.message==`string`?String(e.message):String(e),error:e});if(!window.dispatchEvent(t))return}else if(typeof process==`object`&&typeof process.emit==`function`){process.emit(`uncaughtException`,e);return}console.error(e)};function pe(e){var t=S.T,n={};n.types=t===null?null:t.types,S.T=n;try{var r=e(),i=S.S;i!==null&&i(n,r),typeof r==`object`&&r&&typeof r.then==`function`&&r.then(x,fe)}catch(e){fe(e)}finally{t!==null&&n.types!==null&&(t.types=n.types),S.T=t}}function me(e){var t=S.T;if(t!==null){var n=t.types;n===null?t.types=[e]:n.indexOf(e)===-1&&n.push(e)}else pe(me.bind(null,e))}var he={map:de,forEach:function(e,t,n){de(e,function(){t.apply(this,arguments)},n)},count:function(e){var t=0;return de(e,function(){t++}),t},toArray:function(e){return de(e,function(e){return e})||[]},only:function(e){if(!ae(e))throw Error(`React.Children.only expected to receive a single React element child.`);return e}};e.Activity=f,e.Children=he,e.Component=y,e.Fragment=r,e.Profiler=a,e.PureComponent=ee,e.StrictMode=i,e.Suspense=l,e.ViewTransition=p,e.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=S,e.__COMPILER_RUNTIME={__proto__:null,c:function(e){return S.H.useMemoCache(e)}},e.addTransitionType=me,e.cache=function(e){return function(){return e.apply(null,arguments)}},e.cacheSignal=function(){return null},e.cloneElement=function(e,t,n){if(e==null)throw Error(`The argument must be a React element, but you passed `+e+`.`);var r=_({},e.props),i=e.key;if(t!=null)for(a in t.key!==void 0&&(i=``+t.key),t)!re.call(t,a)||a===`key`||a===`__self`||a===`__source`||a===`ref`&&t.ref===void 0||(r[a]=t[a]);var a=arguments.length-2;if(a===1)r.children=n;else if(1<a){for(var o=Array(a),s=0;s<a;s++)o[s]=arguments[s+2];r.children=o}return C(e.type,i,r)},e.createContext=function(e){return e={$$typeof:s,_currentValue:e,_currentValue2:e,_threadCount:0,Provider:null,Consumer:null},e.Provider=e,e.Consumer={$$typeof:o,_context:e},e},e.createElement=function(e,t,n){var r,i={},a=null;if(t!=null)for(r in t.key!==void 0&&(a=``+t.key),t)re.call(t,r)&&r!==`key`&&r!==`__self`&&r!==`__source`&&(i[r]=t[r]);var o=arguments.length-2;if(o===1)i.children=n;else if(1<o){for(var s=Array(o),c=0;c<o;c++)s[c]=arguments[c+2];i.children=s}if(e&&e.defaultProps)for(r in o=e.defaultProps,o)i[r]===void 0&&(i[r]=o[r]);return C(e,a,i)},e.createRef=function(){return{current:null}},e.forwardRef=function(e){return{$$typeof:c,render:e}},e.isValidElement=ae,e.lazy=function(e){return{$$typeof:d,_payload:{_status:-1,_result:e},_init:w}},e.memo=function(e,t){return{$$typeof:u,type:e,compare:t===void 0?null:t}},e.startTransition=pe,e.unstable_useCacheRefresh=function(){return S.H.useCacheRefresh()},e.use=function(e){return S.H.use(e)},e.useActionState=function(e,t,n){return S.H.useActionState(e,t,n)},e.useCallback=function(e,t){return S.H.useCallback(e,t)},e.useContext=function(e){return S.H.useContext(e)},e.useDebugValue=function(){},e.useDeferredValue=function(e,t){return S.H.useDeferredValue(e,t)},e.useEffect=function(e,t){return S.H.useEffect(e,t)},e.useEffectEvent=function(e){return S.H.useEffectEvent(e)},e.useId=function(){return S.H.useId()},e.useImperativeHandle=function(e,t,n){return S.H.useImperativeHandle(e,t,n)},e.useInsertionEffect=function(e,t){return S.H.useInsertionEffect(e,t)},e.useLayoutEffect=function(e,t){return S.H.useLayoutEffect(e,t)},e.useMemo=function(e,t){return S.H.useMemo(e,t)},e.useOptimistic=function(e,t){return S.H.useOptimistic(e,t)},e.useReducer=function(e,t,n){return S.H.useReducer(e,t,n)},e.useRef=function(e){return S.H.useRef(e)},e.useState=function(e){return S.H.useState(e)},e.useSyncExternalStore=function(e,t,n){return S.H.useSyncExternalStore(e,t,n)},e.useTransition=function(){return S.H.useTransition()},e.version=`19.3.1`})),n=e(((e,n)=>{n.exports=t()})),r=e((e=>{function t(e,t){var n=e.length;e.push(t);a:for(;0<n;){var r=n-1>>>1,a=e[r];if(0<i(a,t))e[r]=t,e[n]=a,n=r;else break a}}function n(e){return e.length===0?null:e[0]}function r(e){if(e.length===0)return null;var t=e[0],n=e.pop();if(n!==t){e[0]=n;a:for(var r=0,a=e.length,o=a>>>1;r<o;){var s=2*(r+1)-1,c=e[s],l=s+1,u=e[l];if(0>i(c,n))l<a&&0>i(u,c)?(e[r]=u,e[l]=n,r=l):(e[r]=c,e[s]=n,r=s);else if(l<a&&0>i(u,n))e[r]=u,e[l]=n,r=l;else break a}}return t}function i(e,t){var n=e.sortIndex-t.sortIndex;return n===0?e.id-t.id:n}if(e.unstable_now=void 0,typeof performance==`object`&&typeof performance.now==`function`){var a=performance;e.unstable_now=function(){return a.now()}}else{var o=Date,s=o.now();e.unstable_now=function(){return o.now()-s}}var c=[],l=[],u=1,d=null,f=3,p=!1,m=!1,h=!1,g=!1,_=typeof setTimeout==`function`?setTimeout:null,v=typeof clearTimeout==`function`?clearTimeout:null,y=typeof setImmediate<`u`?setImmediate:null;function b(e){for(var i=n(l);i!==null;){if(i.callback===null)r(l);else if(i.startTime<=e)r(l),i.sortIndex=i.expirationTime,t(c,i);else break;i=n(l)}}function ee(e){if(h=!1,b(e),!m){if(n(c)!==null)m=!0,te||(te=!0,ie());else{var t=n(l);t!==null&&se(ee,t.startTime-e)}}}var te=!1,ne=-1,x=5,S=-1;function re(){return g?!0:!(e.unstable_now()-S<x)}function C(){if(g=!1,te){var t=e.unstable_now();S=t;var i=!0;try{a:{m=!1,h&&(h=!1,v(ne),ne=-1),p=!0;var a=f;try{b:{for(b(t),d=n(c);d!==null&&!(d.expirationTime>t&&re());){var o=d.callback;if(typeof o==`function`){d.callback=null,f=d.priorityLevel;var s=o(d.expirationTime<=t);if(t=e.unstable_now(),typeof s==`function`){d.callback=s,b(t),i=!0;break b}d===n(c)&&r(c),b(t)}else r(c);d=n(c)}if(d!==null)i=!0;else{var u=n(l);u!==null&&se(ee,u.startTime-t),i=!1}}break a}finally{d=null,f=a,p=!1}i=void 0}}finally{i?ie():te=!1}}}var ie;if(typeof y==`function`)ie=function(){y(C)};else if(typeof MessageChannel<`u`){var ae=new MessageChannel,oe=ae.port2;ae.port1.onmessage=C,ie=function(){oe.postMessage(null)}}else ie=function(){_(C,0)};function se(t,n){ne=_(function(){t(e.unstable_now())},n)}e.unstable_IdlePriority=5,e.unstable_ImmediatePriority=1,e.unstable_LowPriority=4,e.unstable_NormalPriority=3,e.unstable_Profiling=null,e.unstable_UserBlockingPriority=2,e.unstable_cancelCallback=function(e){e.callback=null},e.unstable_forceFrameRate=function(e){0>e||125<e?console.error(`forceFrameRate takes a positive int between 0 and 125, forcing frame rates higher than 125 fps is not supported`):x=0<e?Math.floor(1e3/e):5},e.unstable_getCurrentPriorityLevel=function(){return f},e.unstable_next=function(e){switch(f){case 1:case 2:case 3:var t=3;break;default:t=f}var n=f;f=t;try{return e()}finally{f=n}},e.unstable_requestPaint=function(){g=!0},e.unstable_runWithPriority=function(e,t){switch(e){case 1:case 2:case 3:case 4:case 5:break;default:e=3}var n=f;f=e;try{return t()}finally{f=n}},e.unstable_scheduleCallback=function(r,i,a){var o=e.unstable_now();switch(typeof a==`object`&&a?(a=a.delay,a=typeof a==`number`&&0<a?o+a:o):a=o,r){case 1:var s=-1;break;case 2:s=250;break;case 5:s=1073741823;break;case 4:s=1e4;break;default:s=5e3}return s=a+s,r={id:u++,callback:i,priorityLevel:r,startTime:a,expirationTime:s,sortIndex:-1},a>o?(r.sortIndex=a,t(l,r),n(c)===null&&r===n(l)&&(h?(v(ne),ne=-1):h=!0,se(ee,a-o))):(r.sortIndex=s,t(c,r),m||p||(m=!0,te||(te=!0,ie()))),r},e.unstable_shouldYield=re,e.unstable_wrapCallback=function(e){var t=f;return function(){var n=f;f=t;try{return e.apply(this,arguments)}finally{f=n}}}})),i=e(((e,t)=>{t.exports=r()})),a=e((e=>{var t=n();function r(e){var t=`https://react.dev/errors/`+e;if(1<arguments.length){t+=`?args[]=`+encodeURIComponent(arguments[1]);for(var n=2;n<arguments.length;n++)t+=`&args[]=`+encodeURIComponent(arguments[n])}return`Minified React error #`+e+`; visit `+t+` for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`}function i(){}var a={d:{f:i,r:function(){throw Error(r(522))},D:i,C:i,L:i,m:i,X:i,S:i,M:i},p:0,findDOMNode:null},o=Symbol.for(`react.portal`),s=Symbol.for(`react.recoverable`),c=Symbol.for(`react.optimistic_key`);function l(e,t,n){var r=3<arguments.length&&arguments[3]!==void 0?arguments[3]:null;return{$$typeof:o,key:r==null?null:r===c?c:``+r,children:e,containerInfo:t,implementation:n}}var u=t.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;function d(e,t){if(e===`font`)return``;if(typeof t==`string`)return t===`use-credentials`?t:``}e.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE=a,e.browser=function(e){return{$$typeof:s,_reason:e}},e.createPortal=function(e,t){var n=2<arguments.length&&arguments[2]!==void 0?arguments[2]:null;if(!t||t.nodeType!==1&&t.nodeType!==9&&t.nodeType!==11)throw Error(r(299));return l(e,t,null,n)},e.flushSync=function(e){var t=u.T,n=a.p;try{if(u.T=null,a.p=2,e)return e()}finally{u.T=t,a.p=n,a.d.f()}},e.preconnect=function(e,t){typeof e==`string`&&(t?(t=t.crossOrigin,t=typeof t==`string`?t===`use-credentials`?t:``:void 0):t=null,a.d.C(e,t))},e.prefetchDNS=function(e){typeof e==`string`&&a.d.D(e)},e.preinit=function(e,t){if(typeof e==`string`&&t&&typeof t.as==`string`){var n=t.as,r=d(n,t.crossOrigin),i=typeof t.integrity==`string`?t.integrity:void 0,o=typeof t.fetchPriority==`string`?t.fetchPriority:void 0;n===`style`?a.d.S(e,typeof t.precedence==`string`?t.precedence:void 0,{crossOrigin:r,integrity:i,fetchPriority:o}):n===`script`&&a.d.X(e,{crossOrigin:r,integrity:i,fetchPriority:o,nonce:typeof t.nonce==`string`?t.nonce:void 0})}},e.preinitModule=function(e,t){if(typeof e==`string`){if(typeof t==`object`&&t){if(t.as==null||t.as===`script`){var n=d(t.as,t.crossOrigin);a.d.M(e,{crossOrigin:n,integrity:typeof t.integrity==`string`?t.integrity:void 0,nonce:typeof t.nonce==`string`?t.nonce:void 0,fetchPriority:typeof t.fetchPriority==`string`?t.fetchPriority:void 0})}}else t??a.d.M(e)}},e.preload=function(e,t){if(typeof e==`string`&&typeof t==`object`&&t&&typeof t.as==`string`){var n=t.as,r=d(n,t.crossOrigin);a.d.L(e,n,{crossOrigin:r,integrity:typeof t.integrity==`string`?t.integrity:void 0,nonce:typeof t.nonce==`string`?t.nonce:void 0,type:typeof t.type==`string`?t.type:void 0,fetchPriority:typeof t.fetchPriority==`string`?t.fetchPriority:void 0,referrerPolicy:typeof t.referrerPolicy==`string`?t.referrerPolicy:void 0,imageSrcSet:typeof t.imageSrcSet==`string`?t.imageSrcSet:void 0,imageSizes:typeof t.imageSizes==`string`?t.imageSizes:void 0,media:typeof t.media==`string`?t.media:void 0})}},e.preloadModule=function(e,t){if(typeof e==`string`){if(t){var n=d(t.as,t.crossOrigin);a.d.m(e,{as:typeof t.as==`string`&&t.as!==`script`?t.as:void 0,crossOrigin:n,integrity:typeof t.integrity==`string`?t.integrity:void 0,nonce:typeof t.nonce==`string`?t.nonce:void 0,fetchPriority:typeof t.fetchPriority==`string`?t.fetchPriority:void 0})}else a.d.m(e)}},e.requestFormReset=function(e){a.d.r(e)},e.unstable_batchedUpdates=function(e,t){return e(t)},e.useFormState=function(e,t,n){return u.H.useFormState(e,t,n)},e.useFormStatus=function(){return u.H.useHostTransitionStatus()},e.version=`19.3.1`})),o=e(((e,t)=>{function n(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<`u`&&typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE==`function`)try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n)}catch(e){console.error(e)}}n(),t.exports=a()})),s=e((e=>{var t=i(),r=n(),a=o();function s(e){var t=`https://react.dev/errors/`+e;if(1<arguments.length){t+=`?args[]=`+encodeURIComponent(arguments[1]);for(var n=2;n<arguments.length;n++)t+=`&args[]=`+encodeURIComponent(arguments[n])}return`Minified React error #`+e+`; visit `+t+` for the full message or use the non-minified dev environment for full errors and additional helpful warnings.`}function c(e){return!(!e||e.nodeType!==1&&e.nodeType!==9&&e.nodeType!==11)}function l(e){for(var t=e,n=t;n&&!n.alternate;)t=n,t.flags&4098&&(e=t.return),n=t.return;for(;t.return;)t=t.return;return t.tag===3?e:null}function u(e){if(e.tag===13){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function d(e){if(e.tag===31){var t=e.memoizedState;if(t===null&&(e=e.alternate,e!==null&&(t=e.memoizedState)),t!==null)return t.dehydrated}return null}function f(e){if(l(e)!==e)throw Error(s(188))}function p(e){var t=e.alternate;if(!t){if(t=l(e),t===null)throw Error(s(188));return t===e?e:null}for(var n=e,r=t;;){var i=n.return;if(i===null)break;var a=i.alternate;if(a===null){if(r=i.return,r!==null){n=r;continue}break}if(i.child===a.child){for(a=i.child;a;){if(a===n)return f(i),e;if(a===r)return f(i),t;a=a.sibling}throw Error(s(188))}if(n.return!==r.return)n=i,r=a;else{for(var o=!1,c=i.child;c;){if(c===n){o=!0,n=i,r=a;break}if(c===r){o=!0,r=i,n=a;break}c=c.sibling}if(!o){for(c=a.child;c;){if(c===n){o=!0,n=a,r=i;break}if(c===r){o=!0,r=a,n=i;break}c=c.sibling}if(!o)throw Error(s(189))}}if(n.alternate!==r)throw Error(s(190))}if(n.tag!==3)throw Error(s(188));return n.stateNode.current===n?e:t}function m(e){var t=e.tag;if(t===5||t===26||t===27||t===6)return e;for(e=e.child;e!==null;){if(t=m(e),t!==null)return t;e=e.sibling}return null}function h(e,t,n,r,i,a){for(;e!==null;){if((e.tag===5||e.tag===27||e.tag===6)&&n(e,r,i,a)||(e.tag!==22||e.memoizedState===null)&&(t||e.tag!==5&&e.tag!==27)&&h(e.child,t,n,r,i,a))return!0;e=e.sibling}return!1}function g(e){for(e=e.return;e!==null;){if(e.tag===3||e.tag===5||e.tag===27)return e;e=e.return}return null}function _(e){var t=!1;for(e=e.return;e!==null&&(e.tag===4&&(t=!0),e.tag!==3&&e.tag!==5&&e.tag!==27);)e=e.return;return t}function v(e){var t=[null,null],n=g(e);return n===null||y(t,e,n.child,{foundSelf:!1}),t}function y(e,t,n,r){for(;n!==null;){if(n===t)r.foundSelf=!0;else if(n.tag===5||n.tag===27||n.tag===6){if(r.foundSelf)return e[1]=n,!0;e[0]=n}else if((n.tag!==22||n.memoizedState===null)&&y(e,t,n.child,r))return!0;n=n.sibling}return!1}function b(e){switch(e.tag){case 5:case 27:case 6:return e.stateNode;case 3:return e.stateNode.containerInfo;default:throw Error(s(559))}}var ee=null,te=null;function ne(e,t,n){return e===n||e===t&&(ee=e,!0)}function x(e,t,n){return e===n?(te=e,!1):e===t&&(te!==null&&(ee=e),!0)}function S(e){if(e===null)return null;do e=e===null?null:e.return;while(e&&e.tag!==5&&e.tag!==27&&e.tag!==3);return e||null}function re(e,t,n){for(var r=0,i=e;i;i=n(i))r++;i=0;for(var a=t;a;a=n(a))i++;for(;0<r-i;)e=n(e),r--;for(;0<i-r;)t=n(t),i--;for(;r--;){if(e===t||t!==null&&e===t.alternate)return e;e=n(e),t=n(t)}return null}var C=Object.assign,ie=Symbol.for(`react.element`),ae=Symbol.for(`react.transitional.element`),oe=Symbol.for(`react.portal`),se=Symbol.for(`react.fragment`),ce=Symbol.for(`react.strict_mode`),le=Symbol.for(`react.profiler`),ue=Symbol.for(`react.consumer`),de=Symbol.for(`react.context`),w=Symbol.for(`react.forward_ref`),fe=Symbol.for(`react.suspense`),pe=Symbol.for(`react.suspense_list`),me=Symbol.for(`react.memo`),he=Symbol.for(`react.lazy`),ge=Symbol.for(`react.activity`),_e=Symbol.for(`react.legacy_hidden`),ve=Symbol.for(`react.memo_cache_sentinel`),ye=Symbol.for(`react.view_transition`),be=Symbol.for(`react.recoverable`),xe=Symbol.iterator;function Se(e){return typeof e!=`object`||!e?null:(e=xe&&e[xe]||e[`@@iterator`],typeof e==`function`?e:null)}var Ce=Symbol.for(`react.client.reference`);function we(e){if(e==null)return null;if(typeof e==`function`)return e.$$typeof===Ce?null:e.displayName||e.name||null;if(typeof e==`string`)return e;switch(e){case se:return`Fragment`;case le:return`Profiler`;case ce:return`StrictMode`;case fe:return`Suspense`;case pe:return`SuspenseList`;case ge:return`Activity`;case ye:return`ViewTransition`}if(typeof e==`object`)switch(e.$$typeof){case oe:return`Portal`;case de:return e.displayName||`Context`;case ue:return(e._context.displayName||`Context`)+`.Consumer`;case w:var t=e.render;return e=e.displayName,e||=(e=t.displayName||t.name||``,e===``?`ForwardRef`:`ForwardRef(`+e+`)`),e;case me:return t=e.displayName||null,t===null?we(e.type)||`Memo`:t;case he:t=e._payload,e=e._init;try{return we(e(t))}catch{}}return null}var Te=Array.isArray,T=r.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,E=a.__DOM_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE,Ee={pending:!1,data:null,method:null,action:null},De=[],Oe=-1;function D(e){return{current:e}}function O(e){0>Oe||(e.current=De[Oe],De[Oe]=null,Oe--)}function k(e,t){Oe++,De[Oe]=e.current,e.current=t}var ke=D(null),Ae=D(null),je=D(null),Me=D(null);function Ne(e,t){switch(k(je,t),k(Ae,e),k(ke,null),t.nodeType){case 9:case 11:e=(e=t.documentElement)&&(e=e.namespaceURI)?up(e):0;break;default:if(e=t.tagName,t=t.namespaceURI)t=up(t),e=dp(t,e);else switch(e){case`svg`:e=1;break;case`math`:e=2;break;default:e=0}}O(ke),k(ke,e)}function Pe(){O(ke),O(Ae),O(je)}function Fe(e){var t=e.memoizedState;t!==null&&(sh._currentValue=t.memoizedState,k(Me,e)),t=ke.current;var n=dp(t,e.type);t!==n&&(k(Ae,e),k(ke,n))}function Ie(e){Ae.current===e&&(O(ke),O(Ae)),Me.current===e&&(O(Me),sh._currentValue=Ee)}var Le,A;function Re(e){if(Le===void 0)try{throw Error()}catch(e){var t=e.stack.trim().match(/\\n( *(at )?)/);Le=t&&t[1]||``,A=-1<e.stack.indexOf(`\n    at`)?` (<anonymous>)`:-1<e.stack.indexOf(`@`)?`@unknown:0:0`:``}return`\n`+Le+e+A}var ze=!1;function Be(e,t){if(!e||ze)return``;ze=!0;var n=Error.prepareStackTrace;Error.prepareStackTrace=void 0;try{var r={DetermineComponentFrameRoot:function(){try{if(t){var n=function(){throw Error()};if(Object.defineProperty(n.prototype,"props",{set:function(){throw Error()}}),typeof Reflect==`object`&&Reflect.construct){try{Reflect.construct(n,[])}catch(e){var r=e}Reflect.construct(e,[],n)}else{try{n.call()}catch(e){r=e}n=!1;try{var i=Object.getOwnPropertyDescriptor(e.prototype,`props`);Object.defineProperty(e.prototype,"props",{configurable:!0,set:function(){throw Error()}}),n=!0,new e}finally{n&&(i===void 0?delete e.prototype.props:Object.defineProperty(e.prototype,"props",i))}}}else{try{throw Error()}catch(e){r=e}(n=e())&&typeof n.catch==`function`&&n.catch(function(){})}}catch(e){if(e&&r&&typeof e.stack==`string`)return[e.stack,r.stack]}return[null,null]}};r.DetermineComponentFrameRoot.displayName=`DetermineComponentFrameRoot`;var i=Object.getOwnPropertyDescriptor(r.DetermineComponentFrameRoot,`name`);i&&i.configurable&&Object.defineProperty(r.DetermineComponentFrameRoot,"name",{value:`DetermineComponentFrameRoot`});var a=r.DetermineComponentFrameRoot(),o=a[0],s=a[1];if(o&&s){var c=o.split(`\n`),l=s.split(`\n`);for(i=r=0;r<c.length&&!c[r].includes(`DetermineComponentFrameRoot`);)r++;for(;i<l.length&&!l[i].includes(`DetermineComponentFrameRoot`);)i++;if(r===c.length||i===l.length)for(r=c.length-1,i=l.length-1;1<=r&&0<=i&&c[r]!==l[i];)i--;for(;1<=r&&0<=i;r--,i--)if(c[r]!==l[i]){if(r!==1||i!==1)do if(r--,i--,0>i||c[r]!==l[i]){var u=`\n`+c[r].replace(` at new `,` at `);return e.displayName&&u.includes(`<anonymous>`)&&(u=u.replace(`<anonymous>`,e.displayName)),u}while(1<=r&&0<=i);break}}}finally{ze=!1,Error.prepareStackTrace=n}return(n=e?e.displayName||e.name:``)?Re(n):``}function Ve(e,t){switch(e.tag){case 26:case 27:case 5:return Re(e.type);case 16:return Re(`Lazy`);case 13:return e.child!==t&&t!==null?Re(`Suspense Fallback`):Re(`Suspense`);case 19:return Re(`SuspenseList`);case 0:case 15:return Be(e.type,!1);case 11:return Be(e.type.render,!1);case 1:return Be(e.type,!0);case 31:return Re(`Activity`);case 30:return Re(`ViewTransition`);default:return``}}function He(e){try{var t=``,n=null;do t+=Ve(e,n),n=e,e=e.return;while(e);return t}catch(e){return`\nError generating stack: `+e.message+`\n`+e.stack}}var Ue=Object.prototype.hasOwnProperty,We=t.unstable_scheduleCallback,j=t.unstable_cancelCallback,Ge=t.unstable_shouldYield,Ke=t.unstable_requestPaint,qe=t.unstable_now,Je=t.unstable_getCurrentPriorityLevel,Ye=t.unstable_ImmediatePriority,Xe=t.unstable_UserBlockingPriority,Ze=t.unstable_NormalPriority,Qe=t.unstable_LowPriority,$e=t.unstable_IdlePriority,et=t.log,tt=t.unstable_setDisableYieldValue,nt=null,rt=null;function it(e){if(typeof et==`function`&&tt(e),rt&&typeof rt.setStrictMode==`function`)try{rt.setStrictMode(nt,e)}catch{}}var at=Math.clz32?Math.clz32:ct,ot=Math.log,st=Math.LN2;function ct(e){return e>>>=0,e===0?32:31-(ot(e)/st|0)|0}var M=256,lt=262144,ut=4194304;function dt(e){var t=e&42;if(t!==0)return t;switch(e&-e){case 1:return 1;case 2:return 2;case 4:return 4;case 8:return 8;case 16:return 16;case 32:return 32;case 64:return 64;case 128:return 128;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:return e&-e;case 262144:case 524288:case 1048576:case 2097152:return e&3932160;case 4194304:case 8388608:case 16777216:case 33554432:return e&62914560;case 67108864:return 67108864;case 134217728:return 134217728;case 268435456:return 268435456;case 536870912:return 536870912;case 1073741824:return 0;default:return e}}function ft(e,t,n){var r=e.pendingLanes;if(r===0)return 0;var i=0,a=e.suspendedLanes,o=e.pingedLanes;e=e.warmLanes;var s=r&134217727;return s===0?(s=r&~a,s===0?o===0?n||(n=r&~e,n!==0&&(i=dt(n))):i=dt(o):i=dt(s)):(r=s&~a,r===0?(o&=s,o===0?n||(n=s&~e,n!==0&&(i=dt(n))):i=dt(o)):i=dt(r)),i===0?0:t!==0&&t!==i&&(t&a)===0&&(a=i&-i,n=t&-t,a>=n||a===32&&n&4194048)?t:i}function pt(e,t){return(e.pendingLanes&~(e.suspendedLanes&~e.pingedLanes)&t)===0}function mt(e,t){t&8&&(t|=t&32);var n=e.entangledLanes;if(n!==0)for(e=e.entanglements,n&=t;0<n;){var r=31-at(n),i=1<<r;t|=e[r],n&=~i}return t}function ht(e,t){switch(e){case 1:case 2:case 4:case 8:case 64:return t+250;case 16:case 32:case 128:case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:return t+5e3;case 4194304:case 8388608:case 16777216:case 33554432:return-1;case 67108864:case 134217728:case 268435456:case 536870912:case 1073741824:return-1;default:return-1}}function gt(){var e=ut;return ut<<=1,!(ut&62914560)&&(ut=4194304),e}function _t(e){for(var t=[],n=0;31>n;n++)t.push(e);return t}function vt(e,t){e.pendingLanes|=t,t!==268435456&&(e.suspendedLanes=0,e.pingedLanes=0,e.warmLanes=0)}function yt(e,t,n,r,i,a){var o=e.pendingLanes;e.pendingLanes=n,e.suspendedLanes=0,e.pingedLanes=0,e.warmLanes=0,e.expiredLanes&=n,e.entangledLanes&=n,e.errorRecoveryDisabledLanes&=n,e.shellSuspendCounter=0;var s=e.entanglements,c=e.expirationTimes,l=e.hiddenUpdates;for(n=o&~n;0<n;){var u=31-at(n),d=1<<u;s[u]=0,c[u]=-1;var f=l[u];if(f!==null)for(l[u]=null,u=0;u<f.length;u++){var p=f[u];p!==null&&(p.lane&=-536870913)}n&=~d}r!==0&&bt(e,r,0),a!==0&&i===0&&e.tag!==0&&(e.suspendedLanes|=a&~(o&~t))}function bt(e,t,n){e.pendingLanes|=t,e.suspendedLanes&=~t;var r=31-at(t);e.entangledLanes|=t,e.entanglements[r]=e.entanglements[r]|1073741824|n&261930}function xt(e,t){var n=e.entangledLanes|=t;for(e=e.entanglements;n;){var r=31-at(n),i=1<<r;i&t|e[r]&t&&(e[r]|=t),n&=~i}}function St(e,t){var n=t&-t;return n=n&42?1:Ct(n),(n&(e.suspendedLanes|t))===0?n:0}function Ct(e){switch(e){case 2:e=1;break;case 8:e=4;break;case 32:e=16;break;case 256:case 512:case 1024:case 2048:case 4096:case 8192:case 16384:case 32768:case 65536:case 131072:case 262144:case 524288:case 1048576:case 2097152:case 4194304:case 8388608:case 16777216:case 33554432:e=128;break;case 268435456:e=134217728;break;default:e=0}return e}function wt(e){return e&=-e,2<e?8<e?e&134217727?32:268435456:8:2}function Tt(){var e=E.p;return e===0?(e=window.event,e===void 0?32:Ch(e.type)):e}function Et(e,t){var n=E.p;try{return E.p=e,t()}finally{E.p=n}}var Dt=Math.random().toString(36).slice(2),Ot=`__reactFiber$`+Dt,kt=`__reactProps$`+Dt,At=`__reactContainer$`+Dt,jt=`__reactEvents$`+Dt,Mt=`__reactListeners$`+Dt,Nt=`__reactHandles$`+Dt,Pt=`__reactResources$`+Dt,Ft=`__reactMarker$`+Dt,It=`__reactLoad$`+Dt;function Lt(e){delete e[Ot],delete e[kt],delete e[Mt],delete e[Nt]}function Rt(e){var t;if(t=e[Ot])return t;for(var n=e.parentNode;n;){if(t=n[At]||n[Ot]){if(n=t.alternate,t.child!==null||n!==null&&n.child!==null)for(e=fm(e);e!==null;){if(n=e[Ot])return n;e=fm(e)}return t}e=n,n=e.parentNode}return null}function zt(e){if(e=e[Ot]||e[At]){var t=e.tag;if(t===5||t===6||t===13||t===31||t===26||t===27||t===3)return e}return null}function Bt(e){var t=e.tag;if(t===5||t===26||t===27||t===6)return e.stateNode;throw Error(s(33))}function Vt(e){var t=e[Pt];return t||=e[Pt]={hoistableStyles:new Map,hoistableScripts:new Map},t}function Ht(e){e[Ft]=!0}function Ut(e){e[It]=void 0}var Wt=new Set,Gt={};function Kt(e,t){qt(e,t),qt(e+`Capture`,t)}function qt(e,t){for(Gt[e]=t,e=0;e<t.length;e++)Wt.add(t[e])}var Jt=RegExp(`^[:A-Z_a-z\\\\u00C0-\\\\u00D6\\\\u00D8-\\\\u00F6\\\\u00F8-\\\\u02FF\\\\u0370-\\\\u037D\\\\u037F-\\\\u1FFF\\\\u200C-\\\\u200D\\\\u2070-\\\\u218F\\\\u2C00-\\\\u2FEF\\\\u3001-\\\\uD7FF\\\\uF900-\\\\uFDCF\\\\uFDF0-\\\\uFFFD][:A-Z_a-z\\\\u00C0-\\\\u00D6\\\\u00D8-\\\\u00F6\\\\u00F8-\\\\u02FF\\\\u0370-\\\\u037D\\\\u037F-\\\\u1FFF\\\\u200C-\\\\u200D\\\\u2070-\\\\u218F\\\\u2C00-\\\\u2FEF\\\\u3001-\\\\uD7FF\\\\uF900-\\\\uFDCF\\\\uFDF0-\\\\uFFFD\\\\-.0-9\\\\u00B7\\\\u0300-\\\\u036F\\\\u203F-\\\\u2040]*$`),Yt={},Xt={};function Zt(e){return Ue.call(Xt,e)?!0:Ue.call(Yt,e)?!1:Jt.test(e)?Xt[e]=!0:(Yt[e]=!0,!1)}var N=!1;function Qt(){var e=N;return N=!1,e}function $t(e,t,n){if(Zt(t)){if(n===null)e.removeAttribute(t);else{switch(typeof n){case`undefined`:case`function`:case`symbol`:e.removeAttribute(t);return;case`boolean`:var r=t.toLowerCase().slice(0,5);if(r!==`data-`&&r!==`aria-`){e.removeAttribute(t);return}}e.setAttribute(t,n)}}}function en(e,t,n){if(n===null)e.removeAttribute(t);else{switch(typeof n){case`undefined`:case`function`:case`symbol`:case`boolean`:e.removeAttribute(t);return}e.setAttribute(t,n)}}function P(e,t,n,r){if(r===null)e.removeAttribute(n);else{switch(typeof r){case`undefined`:case`function`:case`symbol`:case`boolean`:e.removeAttribute(n);return}e.setAttributeNS(t,n,r)}}function tn(e){switch(typeof e){case`bigint`:case`boolean`:case`number`:case`string`:case`undefined`:return e;case`object`:return e;default:return``}}function nn(e){var t=e.type;return(e=e.nodeName)&&e.toLowerCase()===`input`&&(t===`checkbox`||t===`radio`)}function rn(e,t,n){var r=Object.getOwnPropertyDescriptor(e.constructor.prototype,t);if(!e.hasOwnProperty(t)&&r!==void 0&&typeof r.get==`function`&&typeof r.set==`function`){var i=r.get,a=r.set;return Object.defineProperty(e,t,{configurable:!0,get:function(){return i.call(this)},set:function(e){n=``+e,a.call(this,e)}}),Object.defineProperty(e,t,{enumerable:r.enumerable}),{getValue:function(){return n},setValue:function(e){n=``+e},stopTracking:function(){e._valueTracker=null,delete e[t]}}}}function an(e){if(!e._valueTracker){var t=nn(e)?`checked`:`value`;e._valueTracker=rn(e,t,``+e[t])}}function on(e){if(!e)return!1;var t=e._valueTracker;if(!t)return!0;var n=t.getValue(),r=``;return e&&(r=nn(e)?e.checked?`true`:`false`:e.value),e=r,e!==n&&(t.setValue(e),!0)}var sn=/[\\n"\\\\]/g;function cn(e){return e.replace(sn,function(e){return`\\\\`+e.charCodeAt(0).toString(16)+` `})}function ln(e,t,n,r,i,a,o,s){e.name=``,o!=null&&typeof o!=`function`&&typeof o!=`symbol`&&typeof o!=`boolean`?e.type=o:e.removeAttribute(`type`),t==null?o!==`submit`&&o!==`reset`||e.removeAttribute(`value`):o===`number`?(t===0&&e.value===``||e.value!=t)&&(e.value=``+tn(t)):e.value!==``+tn(t)&&(e.value=``+tn(t)),t==null?n==null?r!=null&&e.removeAttribute(`value`):dn(e,tn(n)):o===`number`&&e.value==t?dn(e,tn(e.value)):dn(e,tn(t)),i==null&&a!=null&&(e.defaultChecked=!!a),i!=null&&(e.checked=i&&typeof i!=`function`&&typeof i!=`symbol`),s!=null&&typeof s!=`function`&&typeof s!=`symbol`&&typeof s!=`boolean`?e.name=``+tn(s):e.removeAttribute(`name`)}function un(e,t,n,r,i,a,o,s){if(a!=null&&typeof a!=`function`&&typeof a!=`symbol`&&typeof a!=`boolean`&&(e.type=a),t!=null||n!=null){if(!(a!==`submit`&&a!==`reset`||t!=null)){an(e);return}n=n==null?``:``+tn(n),t=t==null?n:``+tn(t),s||t===e.value||(e.value=t),e.defaultValue=t}r??=i,r=typeof r!=`function`&&typeof r!=`symbol`&&!!r,e.checked=s?e.checked:!!r,e.defaultChecked=!!r,o!=null&&typeof o!=`function`&&typeof o!=`symbol`&&typeof o!=`boolean`&&(e.name=o),an(e)}function dn(e,t){e.defaultValue!==``+t&&(e.defaultValue=``+t)}function fn(e,t,n,r){if(e=e.options,t){t={};for(var i=0;i<n.length;i++)t[`$`+n[i]]=!0;for(n=0;n<e.length;n++)i=t.hasOwnProperty(`$`+e[n].value),e[n].selected!==i&&(e[n].selected=i),i&&r&&(e[n].defaultSelected=!0)}else{for(n=``+tn(n),t=null,i=0;i<e.length;i++){if(e[i].value===n){e[i].selected=!0,r&&(e[i].defaultSelected=!0);return}t!==null||e[i].disabled||(t=e[i])}t!==null&&(t.selected=!0)}}function pn(e,t,n){t!=null&&(t=``+tn(t),t!==e.value&&(e.value=t),n==null)?e.defaultValue!==t&&(e.defaultValue=t):e.defaultValue=n==null?``:``+tn(n)}function mn(e,t,n,r){if(t==null){if(r!=null){if(n!=null)throw Error(s(92));if(Te(r)){if(1<r.length)throw Error(s(93));r=r[0]}n=r}n??=``,t=n}n=tn(t),e.defaultValue=n,r=e.textContent,r===n&&r!==``&&r!==null&&(e.value=r),an(e)}function hn(e,t){if(t){var n=e.firstChild;if(n&&n===e.lastChild&&n.nodeType===3){n.nodeValue=t;return}}e.textContent=t}var F=new Set(`animationIterationCount aspectRatio borderImageOutset borderImageSlice borderImageWidth boxFlex boxFlexGroup boxOrdinalGroup columnCount columns flex flexGrow flexPositive flexShrink flexNegative flexOrder gridArea gridRow gridRowEnd gridRowSpan gridRowStart gridColumn gridColumnEnd gridColumnSpan gridColumnStart fontWeight lineClamp lineHeight opacity order orphans scale tabSize widows zIndex zoom fillOpacity floodOpacity stopOpacity strokeDasharray strokeDashoffset strokeMiterlimit strokeOpacity strokeWidth MozAnimationIterationCount MozBoxFlex MozBoxFlexGroup MozLineClamp msAnimationIterationCount msFlex msZoom msFlexGrow msFlexNegative msFlexOrder msFlexPositive msFlexShrink msGridColumn msGridColumnSpan msGridRow msGridRowSpan WebkitAnimationIterationCount WebkitBoxFlex WebKitBoxFlexGroup WebkitBoxOrdinalGroup WebkitColumnCount WebkitColumns WebkitFlex WebkitFlexGrow WebkitFlexPositive WebkitFlexShrink WebkitLineClamp`.split(` `));function gn(e,t,n){var r=t.indexOf(`--`)===0;n==null||typeof n==`boolean`||n===``?r?e.setProperty(t,``):t===`float`?e.cssFloat=``:e[t]=``:r?e.setProperty(t,n):typeof n!=`number`||n===0||F.has(t)?t===`float`?e.cssFloat=n:e[t]=(``+n).trim():e[t]=n+`px`}function _n(e,t,n){if(t!=null&&typeof t!=`object`)throw Error(s(62));if(e=e.style,n!=null){for(var r in n)!n.hasOwnProperty(r)||t!=null&&t.hasOwnProperty(r)||(r.indexOf(`--`)===0?e.setProperty(r,``):r===`float`?e.cssFloat=``:e[r]=``,N=!0);for(var i in t)r=t[i],t.hasOwnProperty(i)&&n[i]!==r&&(gn(e,i,r),N=!0)}else for(var a in t)t.hasOwnProperty(a)&&gn(e,a,t[a])}function vn(e){if(e.indexOf(`-`)===-1)return!1;switch(e){case`annotation-xml`:case`color-profile`:case`font-face`:case`font-face-src`:case`font-face-uri`:case`font-face-format`:case`font-face-name`:case`missing-glyph`:return!1;default:return!0}}var yn=new Map([[`acceptCharset`,`accept-charset`],[`htmlFor`,`for`],[`httpEquiv`,`http-equiv`],[`crossOrigin`,`crossorigin`],[`accentHeight`,`accent-height`],[`alignmentBaseline`,`alignment-baseline`],[`arabicForm`,`arabic-form`],[`baselineShift`,`baseline-shift`],[`capHeight`,`cap-height`],[`clipPath`,`clip-path`],[`clipRule`,`clip-rule`],[`colorInterpolation`,`color-interpolation`],[`colorInterpolationFilters`,`color-interpolation-filters`],[`colorProfile`,`color-profile`],[`colorRendering`,`color-rendering`],[`dominantBaseline`,`dominant-baseline`],[`enableBackground`,`enable-background`],[`fillOpacity`,`fill-opacity`],[`fillRule`,`fill-rule`],[`floodColor`,`flood-color`],[`floodOpacity`,`flood-opacity`],[`fontFamily`,`font-family`],[`fontSize`,`font-size`],[`fontSizeAdjust`,`font-size-adjust`],[`fontStretch`,`font-stretch`],[`fontStyle`,`font-style`],[`fontVariant`,`font-variant`],[`fontWeight`,`font-weight`],[`glyphName`,`glyph-name`],[`glyphOrientationHorizontal`,`glyph-orientation-horizontal`],[`glyphOrientationVertical`,`glyph-orientation-vertical`],[`horizAdvX`,`horiz-adv-x`],[`horizOriginX`,`horiz-origin-x`],[`imageRendering`,`image-rendering`],[`letterSpacing`,`letter-spacing`],[`lightingColor`,`lighting-color`],[`markerEnd`,`marker-end`],[`markerMid`,`marker-mid`],[`markerStart`,`marker-start`],[`maskType`,`mask-type`],[`overlinePosition`,`overline-position`],[`overlineThickness`,`overline-thickness`],[`paintOrder`,`paint-order`],[`panose-1`,`panose-1`],[`pointerEvents`,`pointer-events`],[`renderingIntent`,`rendering-intent`],[`shapeRendering`,`shape-rendering`],[`stopColor`,`stop-color`],[`stopOpacity`,`stop-opacity`],[`strikethroughPosition`,`strikethrough-position`],[`strikethroughThickness`,`strikethrough-thickness`],[`strokeDasharray`,`stroke-dasharray`],[`strokeDashoffset`,`stroke-dashoffset`],[`strokeLinecap`,`stroke-linecap`],[`strokeLinejoin`,`stroke-linejoin`],[`strokeMiterlimit`,`stroke-miterlimit`],[`strokeOpacity`,`stroke-opacity`],[`strokeWidth`,`stroke-width`],[`textAnchor`,`text-anchor`],[`textDecoration`,`text-decoration`],[`textRendering`,`text-rendering`],[`transformOrigin`,`transform-origin`],[`underlinePosition`,`underline-position`],[`underlineThickness`,`underline-thickness`],[`unicodeBidi`,`unicode-bidi`],[`unicodeRange`,`unicode-range`],[`unitsPerEm`,`units-per-em`],[`vAlphabetic`,`v-alphabetic`],[`vHanging`,`v-hanging`],[`vIdeographic`,`v-ideographic`],[`vMathematical`,`v-mathematical`],[`vectorEffect`,`vector-effect`],[`vertAdvY`,`vert-adv-y`],[`vertOriginX`,`vert-origin-x`],[`vertOriginY`,`vert-origin-y`],[`wordSpacing`,`word-spacing`],[`writingMode`,`writing-mode`],[`xmlnsXlink`,`xmlns:xlink`],[`xHeight`,`x-height`]]),bn=/^[\\u0000-\\u001F ]*j[\\r\\n\\t]*a[\\r\\n\\t]*v[\\r\\n\\t]*a[\\r\\n\\t]*s[\\r\\n\\t]*c[\\r\\n\\t]*r[\\r\\n\\t]*i[\\r\\n\\t]*p[\\r\\n\\t]*t[\\r\\n\\t]*:/i;function xn(e){return bn.test(``+e)?`javascript:throw new Error(\'React has blocked a javascript: URL as a security precaution.\')`:e}function Sn(){}var Cn=null;function wn(e){return e=e.target||e.srcElement||window,e.correspondingUseElement&&(e=e.correspondingUseElement),e.nodeType===3?e.parentNode:e}var Tn=null,En=null;function Dn(e){var t=zt(e);if(t&&(e=t.stateNode)){var n=e[kt]||null;a:switch(e=t.stateNode,t.type){case`input`:if(ln(e,n.value,n.defaultValue,n.defaultValue,n.checked,n.defaultChecked,n.type,n.name),t=n.name,n.type===`radio`&&t!=null){for(n=e;n.parentNode;)n=n.parentNode;for(n=n.querySelectorAll(`input[name="`+cn(``+t)+`"][type="radio"]`),t=0;t<n.length;t++){var r=n[t];if(r!==e&&r.form===e.form){var i=r[kt]||null;if(!i)throw Error(s(90));ln(r,i.value,i.defaultValue,i.defaultValue,i.checked,i.defaultChecked,i.type,i.name)}}for(t=0;t<n.length;t++)r=n[t],r.form===e.form&&on(r)}break a;case`textarea`:pn(e,n.value,n.defaultValue);break a;case`select`:t=n.value,t!=null&&fn(e,!!n.multiple,t,!1)}}}var On=!1;function kn(e,t,n){if(On)return e(t,n);On=!0;try{return e(t)}finally{if(On=!1,(Tn!==null||En!==null)&&(zd(),Tn&&(t=Tn,e=En,En=Tn=null,Dn(t),e)))for(t=0;t<e.length;t++)Dn(e[t])}}function An(e,t){var n=e.stateNode;if(n===null)return null;var r=n[kt]||null;if(r===null)return null;n=r[t];a:switch(t){case`onClick`:case`onClickCapture`:case`onDoubleClick`:case`onDoubleClickCapture`:case`onMouseDown`:case`onMouseDownCapture`:case`onMouseMove`:case`onMouseMoveCapture`:case`onMouseUp`:case`onMouseUpCapture`:case`onMouseEnter`:(r=!r.disabled)||(e=e.type,r=e!==`button`&&e!==`input`&&e!==`select`&&e!==`textarea`),e=!r;break a;default:e=!1}if(e)return null;if(n&&typeof n!=`function`)throw Error(s(231,t,typeof n));return n}var jn=typeof window<`u`&&window.document!==void 0&&window.document.createElement!==void 0,Mn=!1;if(jn)try{var Nn={};Object.defineProperty(Nn,"passive",{get:function(){Mn=!0}}),window.addEventListener(`test`,Nn,Nn),window.removeEventListener(`test`,Nn,Nn)}catch{Mn=!1}var Pn=null,Fn=null,In=null;function Ln(){if(In)return In;var e,t=Fn,n=t.length,r,i=`value`in Pn?Pn.value:Pn.textContent,a=i.length;for(e=0;e<n&&t[e]===i[e];e++);var o=n-e;for(r=1;r<=o&&t[n-r]===i[a-r];r++);return In=i.slice(e,1<r?1-r:void 0)}function Rn(e){var t=e.keyCode;return`charCode`in e?(e=e.charCode,e===0&&t===13&&(e=13)):e=t,e===10&&(e=13),32<=e||e===13?e:0}function zn(){return!0}function Bn(){return!1}function Vn(e){function t(t,n,r,i,a){for(var o in this._reactName=t,this._targetInst=r,this.type=n,this.nativeEvent=i,this.target=a,this.currentTarget=null,e)e.hasOwnProperty(o)&&(t=e[o],this[o]=t?t(i):i[o]);return this.isDefaultPrevented=(i.defaultPrevented==null?!1===i.returnValue:i.defaultPrevented)?zn:Bn,this.isPropagationStopped=Bn,this}return C(t.prototype,{preventDefault:function(){this.defaultPrevented=!0;var e=this.nativeEvent;e&&(e.preventDefault?e.preventDefault():typeof e.returnValue!=`unknown`&&(e.returnValue=!1),this.isDefaultPrevented=zn)},stopPropagation:function(){var e=this.nativeEvent;e&&(e.stopPropagation?e.stopPropagation():typeof e.cancelBubble!=`unknown`&&(e.cancelBubble=!0),this.isPropagationStopped=zn)},persist:function(){},isPersistent:zn}),t}var Hn={eventPhase:0,bubbles:0,cancelable:0,timeStamp:function(e){return e.timeStamp||Date.now()},defaultPrevented:0,isTrusted:0},Un=Vn(Hn),Wn=C({},Hn,{view:0,detail:0}),Gn=Vn(Wn),Kn,qn,Jn,Yn=C({},Wn,{screenX:0,screenY:0,clientX:0,clientY:0,pageX:0,pageY:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,getModifierState:or,button:0,buttons:0,relatedTarget:function(e){return e.relatedTarget===void 0?e.fromElement===e.srcElement?e.toElement:e.fromElement:e.relatedTarget},movementX:function(e){return`movementX`in e?e.movementX:(e!==Jn&&(Jn&&e.type===`mousemove`?(Kn=e.screenX-Jn.screenX,qn=e.screenY-Jn.screenY):qn=Kn=0,Jn=e),Kn)},movementY:function(e){return`movementY`in e?e.movementY:qn}}),Xn=Vn(Yn),Zn=Vn(C({},Yn,{dataTransfer:0})),Qn=Vn(C({},Wn,{relatedTarget:0})),$n=Vn(C({},Hn,{animationName:0,elapsedTime:0,pseudoElement:0})),er=Vn(C({},Hn,{clipboardData:function(e){return`clipboardData`in e?e.clipboardData:window.clipboardData}})),tr=Vn(C({},Hn,{data:0})),nr={Esc:`Escape`,Spacebar:` `,Left:`ArrowLeft`,Up:`ArrowUp`,Right:`ArrowRight`,Down:`ArrowDown`,Del:`Delete`,Win:`OS`,Menu:`ContextMenu`,Apps:`ContextMenu`,Scroll:`ScrollLock`,MozPrintableKey:`Unidentified`},rr={8:`Backspace`,9:`Tab`,12:`Clear`,13:`Enter`,16:`Shift`,17:`Control`,18:`Alt`,19:`Pause`,20:`CapsLock`,27:`Escape`,32:` `,33:`PageUp`,34:`PageDown`,35:`End`,36:`Home`,37:`ArrowLeft`,38:`ArrowUp`,39:`ArrowRight`,40:`ArrowDown`,45:`Insert`,46:`Delete`,112:`F1`,113:`F2`,114:`F3`,115:`F4`,116:`F5`,117:`F6`,118:`F7`,119:`F8`,120:`F9`,121:`F10`,122:`F11`,123:`F12`,144:`NumLock`,145:`ScrollLock`,224:`Meta`},ir={Alt:`altKey`,Control:`ctrlKey`,Meta:`metaKey`,Shift:`shiftKey`};function ar(e){var t=this.nativeEvent;return t.getModifierState?t.getModifierState(e):(e=ir[e])?!!t[e]:!1}function or(){return ar}var sr=Vn(C({},Wn,{key:function(e){if(e.key){var t=nr[e.key]||e.key;if(t!==`Unidentified`)return t}return e.type===`keypress`?(e=Rn(e),e===13?`Enter`:String.fromCharCode(e)):e.type===`keydown`||e.type===`keyup`?rr[e.keyCode]||`Unidentified`:``},code:0,location:0,ctrlKey:0,shiftKey:0,altKey:0,metaKey:0,repeat:0,locale:0,getModifierState:or,charCode:function(e){return e.type===`keypress`?Rn(e):0},keyCode:function(e){return e.type===`keydown`||e.type===`keyup`?e.keyCode:0},which:function(e){return e.type===`keypress`?Rn(e):e.type===`keydown`||e.type===`keyup`?e.keyCode:0}})),cr=Vn(C({},Yn,{pointerId:0,width:0,height:0,pressure:0,tangentialPressure:0,tiltX:0,tiltY:0,twist:0,pointerType:0,isPrimary:0})),lr=Vn(C({},Hn,{submitter:0})),ur=Vn(C({},Wn,{touches:0,targetTouches:0,changedTouches:0,altKey:0,metaKey:0,ctrlKey:0,shiftKey:0,getModifierState:or})),dr=Vn(C({},Hn,{propertyName:0,elapsedTime:0,pseudoElement:0})),fr=Vn(C({},Yn,{deltaX:function(e){return`deltaX`in e?e.deltaX:`wheelDeltaX`in e?-e.wheelDeltaX:0},deltaY:function(e){return`deltaY`in e?e.deltaY:`wheelDeltaY`in e?-e.wheelDeltaY:`wheelDelta`in e?-e.wheelDelta:0},deltaZ:0,deltaMode:0})),pr=Vn(C({},Hn,{newState:0,oldState:0,source:0})),mr=[9,13,27,32],hr=jn&&`CompositionEvent`in window,gr=null;jn&&`documentMode`in document&&(gr=document.documentMode);var _r=jn&&`TextEvent`in window&&!gr,vr=jn&&(!hr||gr&&8<gr&&11>=gr),yr=` `,br=!1;function xr(e,t){switch(e){case`keyup`:return mr.indexOf(t.keyCode)!==-1;case`keydown`:return t.keyCode!==229;case`keypress`:case`mousedown`:case`focusout`:return!0;default:return!1}}function Sr(e){return e=e.detail,typeof e==`object`&&`data`in e?e.data:null}var Cr=!1;function wr(e,t){switch(e){case`compositionend`:return Sr(t);case`keypress`:return t.which===32?(br=!0,yr):null;case`textInput`:return e=t.data,e===yr&&br?null:e;default:return null}}function Tr(e,t){if(Cr)return e===`compositionend`||!hr&&xr(e,t)?(e=Ln(),In=Fn=Pn=null,Cr=!1,e):null;switch(e){case`paste`:return null;case`keypress`:if(!(t.ctrlKey||t.altKey||t.metaKey)||t.ctrlKey&&t.altKey){if(t.char&&1<t.char.length)return t.char;if(t.which)return String.fromCharCode(t.which)}return null;case`compositionend`:return vr&&t.locale!==`ko`?null:t.data;default:return null}}var Er={color:!0,date:!0,datetime:!0,"datetime-local":!0,email:!0,month:!0,number:!0,password:!0,range:!0,search:!0,tel:!0,text:!0,time:!0,url:!0,week:!0};function Dr(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t===`input`?!!Er[e.type]:t===`textarea`}function Or(e,t,n,r){Tn?En?En.push(r):En=[r]:Tn=r,t=Jf(t,`onChange`),0<t.length&&(n=new Un(`onChange`,`change`,null,n,r),e.push({event:n,listeners:t}))}var kr=null,Ar=null;function jr(e){Vf(e,0)}function Mr(e){if(on(Bt(e)))return e}function Nr(e,t){if(e===`change`)return t}var Pr=!1;if(jn){var Fr;if(jn){var Ir=`oninput`in document;if(!Ir){var Lr=document.createElement(`div`);Lr.setAttribute(`oninput`,`return;`),Ir=typeof Lr.oninput==`function`}Fr=Ir}else Fr=!1;Pr=Fr&&(!document.documentMode||9<document.documentMode)}function Rr(){kr&&(kr.detachEvent(`onpropertychange`,zr),Ar=kr=null)}function zr(e){if(e.propertyName===`value`&&Mr(Ar)){var t=[];Or(t,Ar,e,wn(e)),kn(jr,t)}}function Br(e,t,n){e===`focusin`?(Rr(),kr=t,Ar=n,kr.attachEvent(`onpropertychange`,zr)):e===`focusout`&&Rr()}function Vr(e){if(e===`selectionchange`||e===`keyup`||e===`keydown`)return Mr(Ar)}function Hr(e,t){if(e===`click`)return Mr(t)}function Ur(e,t){if(e===`input`||e===`change`)return Mr(t)}function Wr(e,t){return e===t&&(e!==0||1/e==1/t)||e!==e&&t!==t}var Gr=typeof Object.is==`function`?Object.is:Wr;function Kr(e,t){if(Gr(e,t))return!0;if(typeof e!=`object`||!e||typeof t!=`object`||!t)return!1;var n=Object.keys(e),r=Object.keys(t);if(n.length!==r.length)return!1;for(r=0;r<n.length;r++){var i=n[r];if(!Ue.call(t,i)||!Gr(e[i],t[i]))return!1}return!0}function qr(e){if(e||=typeof document<`u`?document:void 0,e===void 0)return null;try{return e.activeElement||e.body}catch{return e.body}}function Jr(e){for(;e&&e.firstChild;)e=e.firstChild;return e}function Yr(e,t){var n=Jr(e);e=0;for(var r;n;){if(n.nodeType===3){if(r=e+n.textContent.length,e<=t&&r>=t)return{node:n,offset:t-e};e=r}a:{for(;n;){if(n.nextSibling){n=n.nextSibling;break a}n=n.parentNode}n=void 0}n=Jr(n)}}function Xr(e,t){return e&&t?e===t?!0:e&&e.nodeType===3?!1:t&&t.nodeType===3?Xr(e,t.parentNode):`contains`in e?e.contains(t):e.compareDocumentPosition?!!(e.compareDocumentPosition(t)&16):!1:!1}function Zr(e){e=e!=null&&e.ownerDocument!=null&&e.ownerDocument.defaultView!=null?e.ownerDocument.defaultView:window;for(var t=qr(e.document);t instanceof e.HTMLIFrameElement;){try{var n=typeof t.contentWindow.location.href==`string`}catch{n=!1}if(n)e=t.contentWindow;else break;t=qr(e.document)}return t}function Qr(e){var t=e&&e.nodeName&&e.nodeName.toLowerCase();return t&&(t===`input`&&(e.type===`text`||e.type===`search`||e.type===`tel`||e.type===`url`||e.type===`password`)||t===`textarea`||e.contentEditable===`true`)}var $r=jn&&`documentMode`in document&&11>=document.documentMode,ei=null,ti=null,ni=null,ri=!1;function ii(e,t,n){var r=n.window===n?n.document:n.nodeType===9?n:n.ownerDocument;ri||ei==null||ei!==qr(r)||(r=ei,`selectionStart`in r&&Qr(r)?r={start:r.selectionStart,end:r.selectionEnd}:(r=(r.ownerDocument&&r.ownerDocument.defaultView||window).getSelection(),r={anchorNode:r.anchorNode,anchorOffset:r.anchorOffset,focusNode:r.focusNode,focusOffset:r.focusOffset}),ni&&Kr(ni,r)||(ni=r,r=Jf(ti,`onSelect`),0<r.length&&(t=new Un(`onSelect`,`select`,null,t,n),e.push({event:t,listeners:r}),t.target=ei)))}function ai(e,t){var n={};return n[e.toLowerCase()]=t.toLowerCase(),n[`Webkit`+e]=`webkit`+t,n[`Moz`+e]=`moz`+t,n}var oi={animationend:ai(`Animation`,`AnimationEnd`),animationiteration:ai(`Animation`,`AnimationIteration`),animationstart:ai(`Animation`,`AnimationStart`),transitionrun:ai(`Transition`,`TransitionRun`),transitionstart:ai(`Transition`,`TransitionStart`),transitioncancel:ai(`Transition`,`TransitionCancel`),transitionend:ai(`Transition`,`TransitionEnd`)},si={},ci={};jn&&(ci=document.createElement(`div`).style,`AnimationEvent`in window||(delete oi.animationend.animation,delete oi.animationiteration.animation,delete oi.animationstart.animation),`TransitionEvent`in window||delete oi.transitionend.transition);function li(e){if(si[e])return si[e];if(!oi[e])return e;var t=oi[e],n;for(n in t)if(t.hasOwnProperty(n)&&n in ci)return si[e]=t[n];return e}var ui=li(`animationend`),di=li(`animationiteration`),fi=li(`animationstart`),pi=li(`transitionrun`),mi=li(`transitionstart`),hi=li(`transitioncancel`),gi=li(`transitionend`),_i=new Map,vi=`abort auxClick beforeToggle cancel canPlay canPlayThrough click close contextMenu copy cut drag dragEnd dragEnter dragExit dragLeave dragOver dragStart drop durationChange emptied encrypted ended error fullscreenChange fullscreenError gotPointerCapture input invalid keyDown keyPress keyUp load loadedData loadedMetadata loadStart lostPointerCapture mouseDown mouseMove mouseOut mouseOver mouseUp paste pause play playing pointerCancel pointerDown pointerMove pointerOut pointerOver pointerUp progress rateChange reset resize seeked seeking stalled submit suspend timeUpdate touchCancel touchEnd touchStart volumeChange scroll toggle touchMove waiting wheel`.split(` `);vi.push(`scrollEnd`);function yi(e,t){_i.set(e,t),Kt(t,[e])}var bi=0;function xi(e,t){if(e.name!=null&&e.name!==`auto`)return e.name;if(t.autoName!==null)return t.autoName;e=bd.identifierPrefix;var n=bi++;return e=`_`+e+`t_`+n.toString(32)+`_`,t.autoName=e}function Si(e){if(e==null||typeof e==`string`)return e;var t=null,n=Od;if(n!==null)for(var r=0;r<n.length;r++){var i=e[n[r]];if(i!=null){if(i===`none`)return`none`;t=t==null?i:t+(` `+i)}}return t??e.default}function Ci(e,t){return e=Si(e),t=Si(t),t==null?e===`auto`?null:e:t===`auto`?null:t}var wi=typeof reportError==`function`?reportError:function(e){if(typeof window==`object`&&typeof window.ErrorEvent==`function`){var t=new window.ErrorEvent(`error`,{bubbles:!0,cancelable:!0,message:typeof e==`object`&&e&&typeof e.message==`string`?String(e.message):String(e),error:e});if(!window.dispatchEvent(t))return}else if(typeof process==`object`&&typeof process.emit==`function`){process.emit(`uncaughtException`,e);return}console.error(e)},Ti=[],Ei=0,Di=0;function Oi(){for(var e=Ei,t=Di=Ei=0;t<e;){var n=Ti[t];Ti[t++]=null;var r=Ti[t];Ti[t++]=null;var i=Ti[t];Ti[t++]=null;var a=Ti[t];if(Ti[t++]=null,r!==null&&i!==null){var o=r.pending;o===null?i.next=i:(i.next=o.next,o.next=i),r.pending=i}a!==0&&Mi(n,i,a)}}function ki(e,t,n,r){Ti[Ei++]=e,Ti[Ei++]=t,Ti[Ei++]=n,Ti[Ei++]=r,Di|=r,e.lanes|=r,e=e.alternate,e!==null&&(e.lanes|=r)}function Ai(e,t,n,r){return ki(e,t,n,r),Ni(e)}function ji(e,t){return ki(e,null,null,t),Ni(e)}function Mi(e,t,n){e.lanes|=n;var r=e.alternate;r!==null&&(r.lanes|=n);for(var i=!1,a=e.return;a!==null;)a.childLanes|=n,r=a.alternate,r!==null&&(r.childLanes|=n),a.tag===22&&(e=a.stateNode,e===null||e._visibility&1||(i=!0)),e=a,a=a.return;return e.tag===3?(a=e.stateNode,i&&t!==null&&(i=31-at(n),e=a.hiddenUpdates,r=e[i],r===null?e[i]=[t]:r.push(t),t.lane=n|536870912),a):null}function Ni(e){if(50<kd)throw kd=0,Ad=null,Error(s(185));for(var t=e.return;t!==null;)e=t,t=e.return;return e.tag===3?e.stateNode:null}var Pi={};function Fi(e,t,n,r){this.tag=e,this.key=n,this.sibling=this.child=this.return=this.stateNode=this.type=this.elementType=null,this.index=0,this.refCleanup=this.ref=null,this.pendingProps=t,this.dependencies=this.memoizedState=this.updateQueue=this.memoizedProps=null,this.mode=r,this.subtreeFlags=this.flags=0,this.deletions=null,this.childLanes=this.lanes=0,this.alternate=null}function Ii(e,t,n,r){return new Fi(e,t,n,r)}function Li(e){return e=e.prototype,!(!e||!e.isReactComponent)}function Ri(e,t){var n=e.alternate;return n===null?(n=Ii(e.tag,t,e.key,e.mode),n.elementType=e.elementType,n.type=e.type,n.stateNode=e.stateNode,n.alternate=e,e.alternate=n):(n.pendingProps=t,n.type=e.type,n.flags=0,n.subtreeFlags=0,n.deletions=null),n.flags=e.flags&1206910976,n.childLanes=e.childLanes,n.lanes=e.lanes,n.child=e.child,n.memoizedProps=e.memoizedProps,n.memoizedState=e.memoizedState,n.updateQueue=e.updateQueue,t=e.dependencies,n.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext},n.sibling=e.sibling,n.index=e.index,n.ref=e.ref,n.refCleanup=e.refCleanup,n}function zi(e,t){e.flags&=1206910978;var n=e.alternate;return n===null?(e.childLanes=0,e.lanes=t,e.child=null,e.subtreeFlags=0,e.memoizedProps=null,e.memoizedState=null,e.updateQueue=null,e.dependencies=null,e.stateNode=null):(e.childLanes=n.childLanes,e.lanes=n.lanes,e.child=n.child,e.subtreeFlags=0,e.deletions=null,e.memoizedProps=n.memoizedProps,e.memoizedState=n.memoizedState,e.updateQueue=n.updateQueue,e.type=n.type,t=n.dependencies,e.dependencies=t===null?null:{lanes:t.lanes,firstContext:t.firstContext}),e}function Bi(e,t,n,r,i,a){var o=0;if(r=e,typeof r==`function`)Li(r)&&(o=1);else if(typeof r==`string`)o=qm(e,n,ke.current)?26:e===`html`||e===`head`||e===`body`?27:5;else a:switch(r){case ge:return e=Ii(31,n,t,i),e.elementType=ge,e.lanes=a,e;case se:return Vi(n.children,i,a,t);case ce:o=8,i|=24;break;case le:return e=Ii(12,n,t,i|2),e.elementType=le,e.lanes=a,e;case fe:return e=Ii(13,n,t,i),e.elementType=fe,e.lanes=a,e;case pe:return e=Ii(19,n,t,i),e.elementType=pe,e.lanes=a,e;case _e:case ye:return e=i|32,e=Ii(30,n,t,e),e.elementType=ye,e.lanes=a,e.stateNode={autoName:null,paired:null,clones:null,ref:null},e;default:if(typeof r==`object`&&r)switch(r.$$typeof){case de:o=10;break a;case ue:o=9;break a;case w:o=11;break a;case me:o=14;break a;case he:o=16,r=null;break a}o=29,n=Error(s(130,e===null?`null`:typeof e,``)),r=null}return t=Ii(o,n,t,i),t.elementType=e,t.type=r,t.lanes=a,t}function Vi(e,t,n,r){return e=Ii(7,e,r,t),e.lanes=n,e}function Hi(e,t,n){return e=Ii(6,e,null,t),e.lanes=n,e}function Ui(e){var t=Ii(18,null,null,0);return t.stateNode=e,t}function Wi(e,t,n){return t=Ii(4,e.children===null?[]:e.children,e.key,t),t.lanes=n,t.stateNode={containerInfo:e.containerInfo,pendingChildren:null,implementation:e.implementation},t}var Gi=new WeakMap;function Ki(e,t){if(typeof e==`object`&&e){var n=Gi.get(e);return n===void 0?(t={value:e,source:t,stack:He(t)},Gi.set(e,t),t):n}return{value:e,source:t,stack:He(t)}}var qi=[],Ji=0,Yi=null,Xi=0,Zi=[],Qi=0,$i=null,ea=1,ta=``;function na(e,t){qi[Ji++]=Xi,qi[Ji++]=Yi,Yi=e,Xi=t}function ra(e,t,n){Zi[Qi++]=ea,Zi[Qi++]=ta,Zi[Qi++]=$i,$i=e;var r=ea;e=ta;var i=32-at(r)-1;r&=~(1<<i),n+=1;var a=32-at(t)+i;if(30<a){var o=i-i%5;a=(r&(1<<o)-1).toString(32),r>>=o,i-=o,ea=1<<32-at(t)+i|n<<i|r,ta=a+e}else ea=1<<a|n<<i|r,ta=e}function ia(e){e.return!==null&&(na(e,1),ra(e,1,0))}function aa(e){for(;e===Yi;)Yi=qi[--Ji],qi[Ji]=null,Xi=qi[--Ji],qi[Ji]=null;for(;e===$i;)$i=Zi[--Qi],Zi[Qi]=null,ta=Zi[--Qi],Zi[Qi]=null,ea=Zi[--Qi],Zi[Qi]=null}function oa(e,t){Zi[Qi++]=ea,Zi[Qi++]=ta,Zi[Qi++]=$i,ea=t.id,ta=t.overflow,$i=e}var sa=null,I=null,L=!1,ca=null,la=!1,ua=Error(s(519));function da(e){throw _a(Ki(Error(s(418,1<arguments.length&&arguments[1]!==void 0&&arguments[1]?`text`:`HTML`,``)),e)),ua}function fa(e){var t=e.stateNode,n=e.type,r=e.memoizedProps;switch(t[Ot]=e,t[kt]=r,n){case`dialog`:Q(`cancel`,t),Q(`close`,t);break;case`iframe`:case`object`:case`embed`:Q(`load`,t);break;case`video`:case`audio`:for(n=0;n<zf.length;n++)Q(zf[n],t);break;case`source`:Q(`error`,t);break;case`img`:case`image`:case`link`:Q(`error`,t),Q(`load`,t);break;case`details`:Q(`toggle`,t);break;case`input`:Q(`invalid`,t),un(t,r.value,r.defaultValue,r.checked,r.defaultChecked,r.type,r.name,!0);break;case`select`:Q(`invalid`,t);break;case`textarea`:Q(`invalid`,t),mn(t,r.value,r.defaultValue,r.children)}n=r.children,typeof n!=`string`&&typeof n!=`number`&&typeof n!=`bigint`||t.textContent===``+n||!0===r.suppressHydrationWarning||ep(t.textContent,n)?(r.popover!=null&&(Q(`beforetoggle`,t),Q(`toggle`,t)),r.onScroll!=null&&Q(`scroll`,t),r.onScrollEnd!=null&&Q(`scrollend`,t),r.onClick!=null&&(t.onclick=Sn),t=!0):t=!1,t||da(e,!0)}function pa(e){for(sa=e.return;sa;)switch(sa.tag){case 5:case 31:case 13:la=!1;return;case 27:case 3:la=!0;return;default:sa=sa.return}}function ma(e){if(e!==sa)return!1;if(!L)return pa(e),L=!0,!1;var t=e.tag,n;if((n=t!==3&&t!==27)&&((n=t===5)&&(n=e.type,n=n===`form`||n===`button`||pp(e.type,e.memoizedProps)),n=!n),n&&I&&da(e),pa(e),t===13){if(e=e.memoizedState,e=e===null?null:e.dehydrated,!e)throw Error(s(317));I=dm(e)}else if(t===31){if(e=e.memoizedState,e=e===null?null:e.dehydrated,!e)throw Error(s(317));I=dm(e)}else t===27?(t=I,Sp(e.type)?(e=um,um=null,I=e):I=t):I=sa?lm(e.stateNode.nextSibling):null;return!0}function ha(){I=sa=null,L=!1}function ga(){var e=ca;return e!==null&&(pd===null?pd=e:pd.push.apply(pd,e),ca=null),e}function _a(e){ca===null?ca=[e]:ca.push(e)}var va=D(null),ya=null,ba=null;function xa(e,t,n){k(va,t._currentValue),t._currentValue=n}function Sa(e){e._currentValue=va.current,O(va)}function Ca(e,t,n){for(;e!==null;){var r=e.alternate;if((e.childLanes&t)===t?r!==null&&(r.childLanes&t)!==t&&(r.childLanes|=t):(e.childLanes|=t,r!==null&&(r.childLanes|=t)),e===n)break;e=e.return}}function wa(e,t,n,r){var i=e.child;for(i!==null&&(i.return=e);i!==null;){var a=i.dependencies;if(a!==null){var o=i.child;a=a.firstContext;a:for(;a!==null;){var c=a;a=i;for(var l=0;l<t.length;l++)if(c.context===t[l]){a.lanes|=n,c=a.alternate,c!==null&&(c.lanes|=n),Ca(a.return,n,e),r||(o=null);break a}a=c.next}}else if(i.tag===18){if(o=i.return,o===null)throw Error(s(341));o.lanes|=n,a=o.alternate,a!==null&&(a.lanes|=n),Ca(o,n,e),o=null}else i.tag===13&&i.memoizedState!==null&&i.memoizedState.dehydrated===null?(i.lanes|=n,o=i.alternate,o!==null&&(o.lanes|=n),Ca(i.return,n,e),o=i.child,o=o===null?null:o.sibling):o=i.child;if(o!==null)o.return=i;else for(o=i;o!==null;){if(o===e){o=null;break}if(i=o.sibling,i!==null){i.return=o.return,o=i;break}o=o.return}i=o}}function Ta(e,t,n,r){e=null;for(var i=t,a=!1;i!==null;){if(!a){if(i.flags&524288)a=!0;else if(i.flags&262144)break}if(i.tag===10){var o=i.alternate;if(o===null)throw Error(s(387));if(o=o.memoizedProps,o!==null){var c=i.type;Gr(i.pendingProps.value,o.value)||(e===null?e=[c]:e.push(c))}}else if(i===Me.current){if(o=i.alternate,o===null)throw Error(s(387));o.memoizedState.memoizedState!==i.memoizedState.memoizedState&&(e===null?e=[sh]:e.push(sh))}i=i.return}return e!==null&&wa(t,e,n,r),t.flags|=262144,e!==null}function Ea(e){for(e=e.firstContext;e!==null;){if(!Gr(e.context._currentValue,e.memoizedValue))return!0;e=e.next}return!1}function Da(e){ya=e,ba=null,e=e.dependencies,e!==null&&(e.firstContext=null)}function Oa(e){return Aa(ya,e)}function ka(e,t){return ya===null&&Da(e),Aa(e,t)}function Aa(e,t){var n=t._currentValue;if(t={context:t,memoizedValue:n,next:null},ba===null){if(e===null)throw Error(s(308));ba=t,e.dependencies={lanes:0,firstContext:t},e.flags|=524288}else ba=ba.next=t;return n}var ja=typeof AbortController<`u`?AbortController:function(){var e=[],t=this.signal={aborted:!1,addEventListener:function(t,n){e.push(n)}};this.abort=function(){t.aborted=!0,e.forEach(function(e){return e()})}},Ma=t.unstable_scheduleCallback,Na=t.unstable_NormalPriority,Pa={$$typeof:de,Consumer:null,Provider:null,_currentValue:null,_currentValue2:null,_threadCount:0};function Fa(){return{controller:new ja,data:new Map,refCount:0}}function Ia(e){e.refCount--,e.refCount===0&&Ma(Na,function(){e.controller.abort()})}function La(e,t){if(e.pendingLanes&4194048){var n=e.transitionTypes;for(n===null&&(n=e.transitionTypes=[]),e=0;e<t.length;e++){var r=t[e];n.indexOf(r)===-1&&n.push(r)}}}var Ra=null;function za(e){var t=e.transitionTypes;return e.transitionTypes=null,t}var Ba=null,Va=0,Ha=0,Ua=null;function Wa(e,t){if(Ba===null){var n=Ba=[];Va=0,Ha=Pf(),Ua={status:`pending`,value:void 0,then:function(e){n.push(e)}}}return Va++,t.then(Ga,Ga),t}function Ga(){if(--Va===0&&(Ra=null,Ba!==null)){Ua!==null&&(Ua.status=`fulfilled`);var e=Ba;Ba=null,Ha=0,Ua=null;for(var t=0;t<e.length;t++)(0,e[t])()}}function Ka(e,t){var n=[],r={status:`pending`,value:null,reason:null,then:function(e){n.push(e)}};return e.then(function(){r.status=`fulfilled`,r.value=t;for(var e=0;e<n.length;e++)(0,n[e])(t)},function(e){for(r.status=`rejected`,r.reason=e,e=0;e<n.length;e++)(0,n[e])(void 0)}),r}var qa=T.S;T.S=function(e,t){if(gd=qe(),typeof t==`object`&&t&&typeof t.then==`function`&&Wa(e,t),Ra!==null)for(var n=bf;n!==null;)La(n,Ra),n=n.next;if(n=e.types,n!==null){for(var r=bf;r!==null;)La(r,n),r=r.next;if(Ha!==0){r=Ra,r===null&&(r=Ra=[]);for(var i=0;i<n.length;i++){var a=n[i];r.indexOf(a)===-1&&r.push(a)}}}qa!==null&&qa(e,t)};var Ja=D(null);function Ya(){var e=Ja.current;return e===null?G.pooledCache:e}function Xa(e,t){t===null?k(Ja,Ja.current):k(Ja,t.pool)}function Za(){var e=Ya();return e===null?null:{parent:Pa._currentValue,pool:e}}var Qa=Error(s(460)),$a=Error(s(474)),eo=Error(s(542)),to={then:function(){}};function no(e){return e=e.status,e===`fulfilled`||e===`rejected`}function ro(e,t,n){switch(n=e[n],n===void 0?e.push(t):n!==t&&(t.then(Sn,Sn),t=n),t.status){case`fulfilled`:return t.value;case`rejected`:throw e=t.reason,so(e),e===void 0&&!(`reason`in t)?Error(s(600)):e;default:if(typeof t.status==`string`)t.then(Sn,Sn);else{if(e=G,e!==null&&100<e.shellSuspendCounter)throw Error(s(482));e=t,e.status=`pending`,e.then(function(e){if(t.status===`pending`){var n=t;n.status=`fulfilled`,n.value=e}},function(e){if(t.status===`pending`){var n=t;n.status=`rejected`,n.reason=e}})}switch(t.status){case`fulfilled`:return t.value;case`rejected`:throw e=t.reason,so(e),e}throw ao=t,Qa}}function io(e){try{var t=e._init;return t(e._payload)}catch(e){throw typeof e==`object`&&e&&typeof e.then==`function`?(ao=e,Qa):e}}var ao=null;function oo(){if(ao===null)throw Error(s(459));var e=ao;return ao=null,e}function so(e){if(e===Qa||e===eo)throw Error(s(483))}var co=null,lo=0;function uo(e){var t=lo;return lo+=1,co===null&&(co=[]),ro(co,e,t)}function fo(e,t){t=t.props.ref,e.ref=t===void 0?null:t}function po(e,t){throw t.$$typeof===ie?Error(s(525)):(e=Object.prototype.toString.call(t),Error(s(31,e===`[object Object]`?`object with keys {`+Object.keys(t).join(`, `)+`}`:e)))}function mo(e){function t(t,n){if(e){var r=t.deletions;r===null?(t.deletions=[n],t.flags|=16):r.push(n)}}function n(n,r){if(!e)return null;for(;r!==null;)t(n,r),r=r.sibling;return null}function r(e){for(var t=new Map;e!==null;)e.key===null?t.set(e.index,e):t.set(e.key,e),e=e.sibling;return t}function i(e,t){return e=Ri(e,t),e.index=0,e.sibling=null,e}function a(t,n,r){return t.index=r,e?(r=t.alternate,r===null?(t.flags|=134217730,n):(r=r.index,r<n?(t.flags|=2,n):r)):(t.flags|=1048576,n)}function o(t){return e&&t.alternate===null&&(t.flags|=134217730),t}function c(e,t,n,r){return t===null||t.tag!==6?(t=Hi(n,e.mode,r),t.return=e,t):(t=i(t,n),t.return=e,t)}function l(e,t,n,r){var a=n.type;return a===se?(e=d(e,t,n.props.children,r,n.key),fo(e,n),e):t!==null&&(t.elementType===a||typeof a==`object`&&a&&a.$$typeof===he&&io(a)===t.type)?(t=i(t,n.props),fo(t,n),t.return=e,t):(t=Bi(n.type,n.key,n.props,null,e.mode,r),fo(t,n),t.return=e,t)}function u(e,t,n,r){return t===null||t.tag!==4||t.stateNode.containerInfo!==n.containerInfo||t.stateNode.implementation!==n.implementation?(t=Wi(n,e.mode,r),t.return=e,t):(t=i(t,n.children||[]),t.return=e,t)}function d(e,t,n,r,a){return t===null||t.tag!==7?(t=Vi(n,e.mode,r,a),t.return=e,t):(t=i(t,n),t.return=e,t)}function f(e,t,n){if(typeof t==`string`&&t!==``||typeof t==`number`||typeof t==`bigint`)return t=Hi(``+t,e.mode,n),t.return=e,t;if(typeof t==`object`&&t){switch(t.$$typeof){case ae:return n=Bi(t.type,t.key,t.props,null,e.mode,n),fo(n,t),n.return=e,n;case oe:return t=Wi(t,e.mode,n),t.return=e,t;case he:return t=io(t),f(e,t,n)}if(Te(t)||Se(t))return t=Vi(t,e.mode,n,null),t.return=e,t;if(typeof t.then==`function`)return f(e,uo(t),n);if(t.$$typeof===de)return f(e,ka(e,t),n);po(e,t)}return null}function p(e,t,n,r){var i=t===null?null:t.key;if(typeof n==`string`&&n!==``||typeof n==`number`||typeof n==`bigint`)return i===null?c(e,t,``+n,r):null;if(typeof n==`object`&&n){switch(n.$$typeof){case ae:return n.key===i?l(e,t,n,r):null;case oe:return n.key===i?u(e,t,n,r):null;case he:return n=io(n),p(e,t,n,r)}if(Te(n)||Se(n))return i===null?d(e,t,n,r,null):null;if(typeof n.then==`function`)return p(e,t,uo(n),r);if(n.$$typeof===de)return p(e,t,ka(e,n),r);po(e,n)}return null}function m(e,t,n,r,i){if(typeof r==`string`&&r!==``||typeof r==`number`||typeof r==`bigint`)return e=e.get(n)||null,c(t,e,``+r,i);if(typeof r==`object`&&r){switch(r.$$typeof){case ae:return e=e.get(r.key===null?n:r.key)||null,l(t,e,r,i);case oe:return e=e.get(r.key===null?n:r.key)||null,u(t,e,r,i);case he:return r=io(r),m(e,t,n,r,i)}if(Te(r)||Se(r))return e=e.get(n)||null,d(t,e,r,i,null);if(typeof r.then==`function`)return m(e,t,n,uo(r),i);if(r.$$typeof===de)return m(e,t,n,ka(t,r),i);po(t,r)}return null}function h(i,o,s,c){for(var l=null,u=null,d=o,h=o=0,g=null;d!==null&&h<s.length;h++){d.index>h?(g=d,d=null):g=d.sibling;var _=p(i,d,s[h],c);if(_===null){d===null&&(d=g);break}e&&d&&_.alternate===null&&t(i,d),o=a(_,o,h),u===null?l=_:u.sibling=_,u=_,d=g}if(h===s.length)return n(i,d),L&&na(i,h),l;if(d===null){for(;h<s.length;h++)d=f(i,s[h],c),d!==null&&(o=a(d,o,h),u===null?l=d:u.sibling=d,u=d);return L&&na(i,h),l}for(d=r(d);h<s.length;h++)g=m(d,i,h,s[h],c),g!==null&&(e&&(_=g.alternate,_!==null&&d.delete(_.key===null?h:_.key)),o=a(g,o,h),u===null?l=g:u.sibling=g,u=g);return e&&d.forEach(function(e){return t(i,e)}),L&&na(i,h),l}function g(i,o,c,l){if(c==null)throw Error(s(151));for(var u=null,d=null,h=o,g=o=0,_=null,v=c.next();h!==null&&!v.done;g++,v=c.next()){h.index>g?(_=h,h=null):_=h.sibling;var y=p(i,h,v.value,l);if(y===null){h===null&&(h=_);break}e&&h&&y.alternate===null&&t(i,h),o=a(y,o,g),d===null?u=y:d.sibling=y,d=y,h=_}if(v.done)return n(i,h),L&&na(i,g),u;if(h===null){for(;!v.done;g++,v=c.next())v=f(i,v.value,l),v!==null&&(o=a(v,o,g),d===null?u=v:d.sibling=v,d=v);return L&&na(i,g),u}for(h=r(h);!v.done;g++,v=c.next())v=m(h,i,g,v.value,l),v!==null&&(e&&(_=v.alternate,_!==null&&h.delete(_.key===null?g:_.key)),o=a(v,o,g),d===null?u=v:d.sibling=v,d=v);return e&&h.forEach(function(e){return t(i,e)}),L&&na(i,g),u}function _(e,r,a,c){if(typeof a==`object`&&a&&a.type===se&&a.key===null&&a.props.ref===void 0&&(a=a.props.children),typeof a==`object`&&a){switch(a.$$typeof){case ae:a:{for(var l=a.key;r!==null;){if(r.key===l){if(l=a.type,l===se){if(r.tag===7){n(e,r.sibling),c=i(r,a.props.children),fo(c,a),c.return=e,e=c;break a}}else if(r.elementType===l||typeof l==`object`&&l&&l.$$typeof===he&&io(l)===r.type){n(e,r.sibling),c=i(r,a.props),fo(c,a),c.return=e,e=c;break a}n(e,r);break}t(e,r),r=r.sibling}a.type===se?(c=Vi(a.props.children,e.mode,c,a.key),fo(c,a),c.return=e,e=c):(c=Bi(a.type,a.key,a.props,null,e.mode,c),fo(c,a),c.return=e,e=c)}return o(e);case oe:a:{for(l=a.key;r!==null;){if(r.key===l){if(r.tag===4&&r.stateNode.containerInfo===a.containerInfo&&r.stateNode.implementation===a.implementation){n(e,r.sibling),c=i(r,a.children||[]),c.return=e,e=c;break a}n(e,r);break}t(e,r),r=r.sibling}c=Wi(a,e.mode,c),c.return=e,e=c}return o(e);case he:return a=io(a),_(e,r,a,c)}if(Te(a))return h(e,r,a,c);if(Se(a)){if(l=Se(a),typeof l!=`function`)throw Error(s(150));return a=l.call(a),g(e,r,a,c)}if(typeof a.then==`function`)return _(e,r,uo(a),c);if(a.$$typeof===de)return _(e,r,ka(e,a),c);po(e,a)}return typeof a==`string`&&a!==``||typeof a==`number`||typeof a==`bigint`?(a=``+a,r!==null&&r.tag===6?(n(e,r.sibling),c=i(r,a),c.return=e,e=c):(n(e,r),c=Hi(a,e.mode,c),c.return=e,e=c),o(e)):n(e,r)}return function(e,t,n,r){try{lo=0;var i=_(e,t,n,r);return co=null,i}catch(t){if(t===Qa||t===eo)throw t;var a=Ii(29,t,null,e.mode);return a.lanes=r,a.return=e,a}}}var ho=mo(!0),go=mo(!1),_o=!1;function vo(e){e.updateQueue={baseState:e.memoizedState,firstBaseUpdate:null,lastBaseUpdate:null,shared:{pending:null,lanes:0,hiddenCallbacks:null},callbacks:null}}function yo(e,t){e=e.updateQueue,t.updateQueue===e&&(t.updateQueue={baseState:e.baseState,firstBaseUpdate:e.firstBaseUpdate,lastBaseUpdate:e.lastBaseUpdate,shared:e.shared,callbacks:null})}function bo(e){return{lane:e,tag:0,payload:null,callback:null,next:null}}function xo(e,t,n){var r=e.updateQueue;if(r===null)return null;if(r=r.shared,W&2){var i=r.pending;return i===null?t.next=t:(t.next=i.next,i.next=t),r.pending=t,t=Ni(e),Mi(e,null,n),t}return ki(e,r,t,n),Ni(e)}function So(e,t,n){if(t=t.updateQueue,t!==null&&(t=t.shared,n&4194048)){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,xt(e,n)}}function Co(e,t){var n=e.updateQueue,r=e.alternate;if(r!==null&&(r=r.updateQueue,n===r)){var i=null,a=null;if(n=n.firstBaseUpdate,n!==null){do{var o={lane:n.lane,tag:n.tag,payload:n.payload,callback:null,next:null};a===null?i=a=o:a=a.next=o,n=n.next}while(n!==null);a===null?i=a=t:a=a.next=t}else i=a=t;n={baseState:r.baseState,firstBaseUpdate:i,lastBaseUpdate:a,shared:r.shared,callbacks:r.callbacks},e.updateQueue=n}else e=n.lastBaseUpdate,e===null?n.firstBaseUpdate=t:e.next=t,n.lastBaseUpdate=t}var wo=!1;function To(){if(wo){var e=Ua;if(e!==null)throw e}}function Eo(e,t,n,r){wo=!1;var i=e.updateQueue;_o=!1;var a=i.firstBaseUpdate,o=i.lastBaseUpdate,s=i.shared.pending;if(s!==null){i.shared.pending=null;var c=s,l=c.next;c.next=null,o===null?a=l:o.next=l,o=c;var u=e.alternate;u!==null&&(u=u.updateQueue,s=u.lastBaseUpdate,s!==o&&(s===null?u.firstBaseUpdate=l:s.next=l,u.lastBaseUpdate=c))}if(a!==null){var d=i.baseState;o=0,u=l=c=null,s=a;do{var f=s.lane&-536870913,p=f!==s.lane;if(p?(q&f)===f:(r&f)===f){f!==0&&f===Ha&&(wo=!0),u!==null&&(u=u.next={lane:0,tag:s.tag,payload:s.payload,callback:null,next:null});a:{var m=e,h=s;f=t;var g=n;switch(h.tag){case 1:if(m=h.payload,typeof m==`function`){d=m.call(g,d,f);break a}d=m;break a;case 3:m.flags=m.flags&-65537|128;case 0:if(m=h.payload,f=typeof m==`function`?m.call(g,d,f):m,f==null)break a;d=C({},d,f);break a;case 2:_o=!0}}f=s.callback,f!==null&&(e.flags|=64,p&&(e.flags|=8192),p=i.callbacks,p===null?i.callbacks=[f]:p.push(f))}else p={lane:f,tag:s.tag,payload:s.payload,callback:s.callback,next:null},u===null?(l=u=p,c=d):u=u.next=p,o|=f;if(s=s.next,s===null){if(s=i.shared.pending,s===null)break;p=s,s=p.next,p.next=null,i.lastBaseUpdate=p,i.shared.pending=null}}while(1);u===null&&(c=d),i.baseState=c,i.firstBaseUpdate=l,i.lastBaseUpdate=u,a===null&&(i.shared.lanes=0),sd|=o,e.lanes=o,e.memoizedState=d}}function Do(e,t){if(typeof e!=`function`)throw Error(s(191,e));e.call(t)}function Oo(e,t){var n=e.callbacks;if(n!==null)for(e.callbacks=null,e=0;e<n.length;e++)Do(n[e],t)}var ko=D(null),Ao=D(0);function jo(e,t){e=od,k(Ao,e),k(ko,t),od=e|t.baseLanes}function Mo(){k(Ao,od),k(ko,ko.current)}function No(){od=Ao.current,O(ko),O(Ao)}var Po=D(null),Fo=null;function Io(e){var t=e.alternate;k(Vo,Vo.current&1),k(Po,e),Fo===null&&(t===null||ko.current!==null||t.memoizedState!==null)&&(Fo=e)}function Lo(e){k(Vo,Vo.current),k(Po,e),Fo===null&&(Fo=e)}function Ro(e){e.tag===22?(k(Vo,Vo.current),k(Po,e),Fo===null&&(Fo=e)):zo()}function zo(){k(Vo,Vo.current),k(Po,Po.current)}function Bo(e){O(Po),Fo===e&&(Fo=null),O(Vo)}var Vo=D(0);function Ho(e,t){k(Po,Po.current),k(Vo,t)}function Uo(e){O(Vo),O(Po),Fo===e&&(Fo=null)}function Wo(e){for(var t=e;t!==null;){if(t.tag===13){var n=t.memoizedState;if(n!==null&&(n=n.dehydrated,n===null||om(n)||sm(n)))return t}else if(t.tag===19&&t.memoizedProps.revealOrder!==`independent`){if(t.flags&128)return t}else if(t.child!==null){t.child.return=t,t=t.child;continue}if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return null;t=t.return}t.sibling.return=t.return,t=t.sibling}return null}var Go=0,R=null,z=null,Ko=null,qo=!1,Jo=!1,Yo=!1,Xo=0,Zo=0,Qo=null,$o=0;function B(){throw Error(s(321))}function es(e,t){if(t===null)return!1;for(var n=0;n<t.length&&n<e.length;n++)if(!Gr(e[n],t[n]))return!1;return!0}function ts(e,t,n,r,i,a){return Go=a,R=t,t.memoizedState=null,t.updateQueue=null,t.lanes=0,T.H=e===null||e.memoizedState===null?vc:yc,Yo=!1,a=n(r,i),Yo=!1,Jo&&(a=rs(t,n,r,i)),ns(e),a}function ns(e){T.H=_c;var t=z!==null&&z.next!==null;if(Go=0,Ko=z=R=null,qo=!1,Zo=0,Qo=null,t)throw Error(s(300));e===null||Ic||(e=e.dependencies,e!==null&&Ea(e)&&(Ic=!0))}function rs(e,t,n,r){R=e;var i=0;do{if(Jo&&(Qo=null),Zo=0,Jo=!1,25<=i)throw Error(s(301));if(i+=1,Ko=z=null,e.updateQueue!=null){var a=e.updateQueue;a.lastEffect=null,a.events=null,a.stores=null,a.memoCache!=null&&(a.memoCache.index=0)}T.H=bc,a=t(n,r)}while(Jo);return a}function is(){var e=T.H,t=e.useState()[0];return t=typeof t.then==`function`?ds(t):t,e=e.useState()[0],(z===null?null:z.memoizedState)!==e&&(R.flags|=1024),t}function as(){var e=Xo!==0;return Xo=0,e}function os(e,t,n){t.updateQueue=e.updateQueue,t.flags&=-2053,e.lanes&=~n}function ss(e){if(qo){for(e=e.memoizedState;e!==null;){var t=e.queue;t!==null&&(t.pending=null),e=e.next}qo=!1}Go=0,Ko=z=R=null,Jo=!1,Zo=Xo=0,Qo=null}function cs(){var e={memoizedState:null,baseState:null,baseQueue:null,queue:null,next:null};return Ko===null?R.memoizedState=Ko=e:Ko=Ko.next=e,Ko}function ls(){if(z===null){var e=R.alternate;e=e===null?null:e.memoizedState}else e=z.next;var t=Ko===null?R.memoizedState:Ko.next;if(t!==null)Ko=t,z=e;else{if(e===null)throw R.alternate===null?Error(s(467)):Error(s(310));z=e,e={memoizedState:z.memoizedState,baseState:z.baseState,baseQueue:z.baseQueue,queue:z.queue,next:null},Ko===null?R.memoizedState=Ko=e:Ko=Ko.next=e}return Ko}function us(){return{lastEffect:null,events:null,stores:null,memoCache:null}}function ds(e){var t=Zo;return Zo+=1,Qo===null&&(Qo=[]),e=ro(Qo,e,t),t=R,(Ko===null?t.memoizedState:Ko.next)===null&&(t=t.alternate,T.H=t===null||t.memoizedState===null?vc:yc),e}function fs(e){if(typeof e==`object`&&e){if(typeof e.then==`function`)return ds(e);if(e.$$typeof===be)return;if(e.$$typeof===de)return Oa(e)}throw Error(s(438,String(e)))}function ps(e){var t=null,n=R.updateQueue;if(n!==null&&(t=n.memoCache),t==null){var r=R.alternate;r!==null&&(r=r.updateQueue,r!==null&&(r=r.memoCache,r!=null&&(t={data:r.data.map(function(e){return e.slice()}),index:0})))}if(t??={data:[],index:0},n===null&&(n=us(),R.updateQueue=n),n.memoCache=t,n=t.data[t.index],n===void 0)for(n=t.data[t.index]=Array(e),r=0;r<e;r++)n[r]=ve;return t.index++,n}function ms(e,t){return typeof t==`function`?t(e):t}function hs(e){return gs(ls(),z,e)}function gs(e,t,n){var r=e.queue;if(r===null)throw Error(s(311));r.lastRenderedReducer=n;var i=e.baseQueue,a=r.pending;if(a!==null){if(i!==null){var o=i.next;i.next=a.next,a.next=o}t.baseQueue=i=a,r.pending=null}if(a=e.baseState,i===null)e.memoizedState=a;else{t=i.next;var c=o=null,l=null,u=t,d=!1;do{var f=u.lane&-536870913;if(f===u.lane?(Go&f)===f:(q&f)===f){var p=u.revertLane;if(p===0)l!==null&&(l=l.next={lane:0,revertLane:0,gesture:null,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null}),f===Ha&&(d=!0);else if((Go&p)===p){u=u.next,p===Ha&&(d=!0);continue}else f={lane:0,revertLane:u.revertLane,gesture:null,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null},l===null?(c=l=f,o=a):l=l.next=f,R.lanes|=p,sd|=p;f=u.action,Yo&&n(a,f),a=u.hasEagerState?u.eagerState:n(a,f)}else p={lane:f,revertLane:u.revertLane,gesture:u.gesture,action:u.action,hasEagerState:u.hasEagerState,eagerState:u.eagerState,next:null},l===null?(c=l=p,o=a):l=l.next=p,R.lanes|=f,sd|=f;u=u.next}while(u!==null&&u!==t);if(l===null?o=a:l.next=c,!Gr(a,e.memoizedState)&&(Ic=!0,d&&(n=Ua,n!==null)))throw n;e.memoizedState=a,e.baseState=o,e.baseQueue=l,r.lastRenderedState=a}return i===null&&(r.lanes=0),[e.memoizedState,r.dispatch]}function _s(e){var t=ls(),n=t.queue;if(n===null)throw Error(s(311));n.lastRenderedReducer=e;var r=n.dispatch,i=n.pending,a=t.memoizedState;if(i!==null){n.pending=null;var o=i=i.next;do a=e(a,o.action),o=o.next;while(o!==i);Gr(a,t.memoizedState)||(Ic=!0),t.memoizedState=a,t.baseQueue===null&&(t.baseState=a),n.lastRenderedState=a}return[a,r]}function vs(e,t,n){var r=R,i=ls(),a=L;if(a){if(n===void 0)throw Error(s(407));n=n()}else n=t();var o=!Gr((z||i).memoizedState,n);if(o&&(i.memoizedState=n,Ic=!0),i=i.queue,Us(xs.bind(null,r,i,e),[e]),e=i.getSnapshot!==t||o||Ko!==null&&!!(Ko.memoizedState.tag&1),Rs(e?9:8,{destroy:void 0},bs.bind(null,r,i,n,t),null),e){if(r.flags|=2048,G===null)throw Error(s(349));a||Go&127||ys(r,t,n)}return n}function ys(e,t,n){e.flags|=16384,e={getSnapshot:t,value:n},t=R.updateQueue,t===null?(t=us(),R.updateQueue=t,t.stores=[e]):(n=t.stores,n===null?t.stores=[e]:n.push(e))}function bs(e,t,n,r){t.value=n,t.getSnapshot=r,Ss(t)&&Cs(e)}function xs(e,t,n){return n(function(){Ss(t)&&Cs(e)})}function Ss(e){var t=e.getSnapshot;e=e.value;try{var n=t();return!Gr(e,n)}catch{return!0}}function Cs(e){var t=ji(e,2);t!==null&&Pd(t,e,2)}function ws(e){var t=cs();if(typeof e==`function`){var n=e;if(e=n(),Yo){it(!0);try{n()}finally{it(!1)}}}return t.memoizedState=t.baseState=e,t.queue={pending:null,lanes:0,dispatch:null,lastRenderedReducer:ms,lastRenderedState:e},t}function Ts(e,t,n,r){return e.baseState=n,gs(e,z,typeof r==`function`?r:ms)}function Es(e,t,n,r,i){if(mc(e))throw Error(s(485));if(e=t.action,e!==null){var a={payload:i,action:e,next:null,isTransition:!0,status:`pending`,value:null,reason:null,listeners:[],then:function(e){a.listeners.push(e)}};T.T===null?a.isTransition=!1:n(!0),r(a),n=t.pending,n===null?(a.next=t.pending=a,Ds(t,a)):(a.next=n.next,t.pending=n.next=a)}}function Ds(e,t){var n=t.action,r=t.payload,i=e.state;if(t.isTransition){var a=T.T,o={};o.types=a===null?null:a.types,T.T=o;try{var s=n(i,r),c=T.S;c!==null&&c(o,s),Os(e,t,s)}catch(n){As(e,t,n)}finally{a!==null&&o.types!==null&&(a.types=o.types),T.T=a}}else try{a=n(i,r),Os(e,t,a)}catch(n){As(e,t,n)}}function Os(e,t,n){typeof n==`object`&&n&&typeof n.then==`function`?n.then(function(n){ks(e,t,n)},function(n){return As(e,t,n)}):ks(e,t,n)}function ks(e,t,n){t.status=`fulfilled`,t.value=n,js(t),e.state=n,t=e.pending,t!==null&&(n=t.next,n===t?e.pending=null:(n=n.next,t.next=n,Ds(e,n)))}function As(e,t,n){var r=e.pending;if(e.pending=null,r!==null){r=r.next;do t.status=`rejected`,t.reason=n,js(t),t=t.next;while(t!==r)}e.action=null}function js(e){e=e.listeners;for(var t=0;t<e.length;t++)(0,e[t])()}function Ms(e,t){return t}function Ns(e,t){if(L){var n=G.formState;if(n!==null){a:{var r=R;if(L){if(I){b:{for(var i=I,a=la;i.nodeType!==8;)if(!a||(i=lm(i.nextSibling),i===null)){i=null;break b}a=i.data,i=a===`F!`||a===`F`?i:null}if(i){I=lm(i.nextSibling),r=i.data===`F!`;break a}}da(r)}r=!1}r&&(t=n[0])}}return n=cs(),n.memoizedState=n.baseState=t,r={pending:null,lanes:0,dispatch:null,lastRenderedReducer:Ms,lastRenderedState:t},n.queue=r,n=dc.bind(null,R,r),r.dispatch=n,r=ws(!1),a=pc.bind(null,R,!1,r.queue),r=cs(),i={state:t,dispatch:null,action:e,pending:null},r.queue=i,n=Es.bind(null,R,i,a,n),i.dispatch=n,r.memoizedState=e,[t,n,!1]}function Ps(e){return Fs(ls(),z,e)}function Fs(e,t,n){if(t=gs(e,t,Ms)[0],e=hs(ms)[0],typeof t==`object`&&t&&typeof t.then==`function`)try{var r=ds(t)}catch(e){throw e===Qa?eo:e}else r=t;t=ls();var i=t.queue,a=i.dispatch;return n!==t.memoizedState&&(R.flags|=2048,Rs(9,{destroy:void 0},Is.bind(null,i,n),null)),[r,a,e]}function Is(e,t){e.action=t}function Ls(e){var t=ls(),n=z;if(n!==null)return Fs(t,n,e);ls(),t=t.memoizedState,n=ls();var r=n.queue.dispatch;return n.memoizedState=e,[t,r,!1]}function Rs(e,t,n,r){return e={tag:e,create:n,deps:r,inst:t,next:null},t=R.updateQueue,t===null&&(t=us(),R.updateQueue=t),n=t.lastEffect,n===null?t.lastEffect=e.next=e:(r=n.next,n.next=e,e.next=r,t.lastEffect=e),e}function zs(){return ls().memoizedState}function Bs(e,t,n,r){var i=cs();R.flags|=e,i.memoizedState=Rs(1|t,{destroy:void 0},n,r===void 0?null:r)}function Vs(e,t,n,r){var i=ls();r=r===void 0?null:r;var a=i.memoizedState.inst;z!==null&&r!==null&&es(r,z.memoizedState.deps)?i.memoizedState=Rs(t,a,n,r):(R.flags|=e,i.memoizedState=Rs(1|t,a,n,r))}function Hs(e,t){Bs(8390656,8,e,t)}function Us(e,t){Vs(2048,8,e,t)}function Ws(e){R.flags|=4;var t=R.updateQueue;if(t===null)t=us(),R.updateQueue=t,t.events=[e];else{var n=t.events;n===null?t.events=[e]:n.push(e)}}function Gs(e){var t=ls().memoizedState;return Ws({ref:t,nextImpl:e}),function(){if(W&2)throw Error(s(440));return t.impl.apply(void 0,arguments)}}function Ks(e,t){return Vs(4,2,e,t)}function qs(e,t){return Vs(4,4,e,t)}function Js(e,t){if(typeof t==`function`){e=e();var n=t(e);return function(){typeof n==`function`?n():t(null)}}if(t!=null)return e=e(),t.current=e,function(){t.current=null}}function Ys(e,t,n){n=n==null?null:n.concat([e]),Vs(4,4,Js.bind(null,t,e),n)}function Xs(){}function Zs(e,t){var n=ls();t=t===void 0?null:t;var r=n.memoizedState;return t!==null&&es(t,r[1])?r[0]:(n.memoizedState=[e,t],e)}function Qs(e,t){var n=ls();t=t===void 0?null:t;var r=n.memoizedState;if(t!==null&&es(t,r[1]))return r[0];if(r=e(),Yo){it(!0);try{e()}finally{it(!1)}}return n.memoizedState=[r,t],r}function $s(e,t,n){return n===void 0||Go&1073741824&&!(q&261930)?e.memoizedState=t:(e.memoizedState=n,e=Md(),R.lanes|=e,sd|=e,n)}function ec(e,t,n,r){return Gr(n,t)?n:ko.current===null?!(Go&106)||Go&1073741824&&!(q&261930)?(Ic=!0,e.memoizedState=n):(e=Md(),R.lanes|=e,sd|=e,t):(e=$s(e,n,r),Gr(e,t)||(Ic=!0),e)}function tc(e,t,n,r,i){var a=E.p;E.p=a!==0&&8>a?a:8;var o=T.T,s={};s.types=o===null?null:o.types,T.T=s,pc(e,!1,t,n);try{var c=i(),l=T.S;l!==null&&l(s,c),typeof c==`object`&&c&&typeof c.then==`function`?fc(e,t,Ka(c,r),jd(e)):fc(e,t,r,jd(e))}catch(n){fc(e,t,{then:function(){},status:`rejected`,reason:n},jd())}finally{E.p=a,o!==null&&s.types!==null&&(o.types=s.types),T.T=o}}function nc(){}function rc(e,t,n,r){if(e.tag!==5)throw Error(s(476));var i=ic(e).queue;tc(e,i,t,Ee,n===null?nc:function(){return ac(e),n(r)})}function ic(e){var t=e.memoizedState;if(t!==null)return t;t={memoizedState:Ee,baseState:Ee,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:ms,lastRenderedState:Ee},next:null};var n={};return t.next={memoizedState:n,baseState:n,baseQueue:null,queue:{pending:null,lanes:0,dispatch:null,lastRenderedReducer:ms,lastRenderedState:n},next:null},e.memoizedState=t,e=e.alternate,e!==null&&(e.memoizedState=t),t}function ac(e){var t=ic(e);t.next===null&&(t=e.alternate.memoizedState),fc(e,t.next.queue,{},jd())}function oc(){return Oa(sh)}function sc(){return ls().memoizedState}function cc(){return ls().memoizedState}function lc(e){for(var t=e.return;t!==null;){switch(t.tag){case 24:case 3:var n=jd();e=bo(n);var r=xo(t,e,n);r!==null&&(Pd(r,t,n),So(r,t,n)),t={cache:Fa()},e.payload=t;return}t=t.return}}function uc(e,t,n){var r=jd();n={lane:r,revertLane:0,gesture:null,action:n,hasEagerState:!1,eagerState:null,next:null},mc(e)?hc(t,n):(n=Ai(e,t,n,r),n!==null&&(Pd(n,e,r),gc(n,t,r)))}function dc(e,t,n){fc(e,t,n,jd())}function fc(e,t,n,r){var i={lane:r,revertLane:0,gesture:null,action:n,hasEagerState:!1,eagerState:null,next:null};if(mc(e))hc(t,i);else{var a=e.alternate;if(e.lanes===0&&(a===null||a.lanes===0)&&(a=t.lastRenderedReducer,a!==null))try{var o=t.lastRenderedState,s=a(o,n);if(i.hasEagerState=!0,i.eagerState=s,Gr(s,o))return ki(e,t,i,0),G===null&&Oi(),!1}catch{}if(n=Ai(e,t,i,r),n!==null)return Pd(n,e,r),gc(n,t,r),!0}return!1}function pc(e,t,n,r){if(r={lane:2,revertLane:Pf(),gesture:null,action:r,hasEagerState:!1,eagerState:null,next:null},mc(e)){if(t)throw Error(s(479))}else t=Ai(e,n,r,2),t!==null&&Pd(t,e,2)}function mc(e){var t=e.alternate;return e===R||t!==null&&t===R}function hc(e,t){Jo=qo=!0;var n=e.pending;n===null?t.next=t:(t.next=n.next,n.next=t),e.pending=t}function gc(e,t,n){if(n&4194048){var r=t.lanes;r&=e.pendingLanes,n|=r,t.lanes=n,xt(e,n)}}var _c={readContext:Oa,use:fs,useCallback:B,useContext:B,useEffect:B,useImperativeHandle:B,useLayoutEffect:B,useInsertionEffect:B,useMemo:B,useReducer:B,useRef:B,useState:B,useDebugValue:B,useDeferredValue:B,useTransition:B,useSyncExternalStore:B,useId:B,useHostTransitionStatus:B,useFormState:B,useActionState:B,useOptimistic:B,useMemoCache:B,useCacheRefresh:B,useEffectEvent:B},vc={readContext:Oa,use:fs,useCallback:function(e,t){return cs().memoizedState=[e,t===void 0?null:t],e},useContext:Oa,useEffect:Hs,useImperativeHandle:function(e,t,n){n=n==null?null:n.concat([e]),Bs(4194308,4,Js.bind(null,t,e),n)},useLayoutEffect:function(e,t){return Bs(4194308,4,e,t)},useInsertionEffect:function(e,t){Bs(4,2,e,t)},useMemo:function(e,t){var n=cs();t=t===void 0?null:t;var r=e();if(Yo){it(!0);try{e()}finally{it(!1)}}return n.memoizedState=[r,t],r},useReducer:function(e,t,n){var r=cs();if(n!==void 0){var i=n(t);if(Yo){it(!0);try{n(t)}finally{it(!1)}}}else i=t;return r.memoizedState=r.baseState=i,e={pending:null,lanes:0,dispatch:null,lastRenderedReducer:e,lastRenderedState:i},r.queue=e,e=e.dispatch=uc.bind(null,R,e),[r.memoizedState,e]},useRef:function(e){var t=cs();return e={current:e},t.memoizedState=e},useState:function(e){e=ws(e);var t=e.queue,n=dc.bind(null,R,t);return t.dispatch=n,[e.memoizedState,n]},useDebugValue:Xs,useDeferredValue:function(e,t){return $s(cs(),e,t)},useTransition:function(){var e=ws(!1);return e=tc.bind(null,R,e.queue,!0,!1),cs().memoizedState=e,[!1,e]},useSyncExternalStore:function(e,t,n){var r=R,i=cs();if(L){if(n===void 0)throw Error(s(407));n=n()}else{if(n=t(),G===null)throw Error(s(349));q&127||ys(r,t,n)}i.memoizedState=n;var a={value:n,getSnapshot:t};return i.queue=a,Hs(xs.bind(null,r,a,e),[e]),r.flags|=2048,Rs(9,{destroy:void 0},bs.bind(null,r,a,n,t),null),n},useId:function(){var e=cs(),t=G.identifierPrefix;if(L){var n=ta,r=ea;n=(r&~(1<<32-at(r)-1)).toString(32)+n,t=`_`+t+`R_`+n,n=Xo++,0<n&&(t+=`H`+n.toString(32)),t+=`_`}else n=$o++,t=`_`+t+`r_`+n.toString(32)+`_`;return e.memoizedState=t},useHostTransitionStatus:oc,useFormState:Ns,useActionState:Ns,useOptimistic:function(e){var t=cs();t.memoizedState=t.baseState=e;var n={pending:null,lanes:0,dispatch:null,lastRenderedReducer:null,lastRenderedState:null};return t.queue=n,t=pc.bind(null,R,!0,n),n.dispatch=t,[e,t]},useMemoCache:ps,useCacheRefresh:function(){return cs().memoizedState=lc.bind(null,R)},useEffectEvent:function(e){var t=cs(),n={impl:e};return t.memoizedState=n,function(){if(W&2)throw Error(s(440));return n.impl.apply(void 0,arguments)}}},yc={readContext:Oa,use:fs,useCallback:Zs,useContext:Oa,useEffect:Us,useImperativeHandle:Ys,useInsertionEffect:Ks,useLayoutEffect:qs,useMemo:Qs,useReducer:hs,useRef:zs,useState:function(){return hs(ms)},useDebugValue:Xs,useDeferredValue:function(e,t){return ec(ls(),z.memoizedState,e,t)},useTransition:function(){var e=hs(ms)[0],t=ls().memoizedState;return[typeof e==`boolean`?e:ds(e),t]},useSyncExternalStore:vs,useId:sc,useHostTransitionStatus:oc,useFormState:Ps,useActionState:Ps,useOptimistic:function(e,t){return Ts(ls(),z,e,t)},useMemoCache:ps,useCacheRefresh:cc,useEffectEvent:Gs},bc={readContext:Oa,use:fs,useCallback:Zs,useContext:Oa,useEffect:Us,useImperativeHandle:Ys,useInsertionEffect:Ks,useLayoutEffect:qs,useMemo:Qs,useReducer:_s,useRef:zs,useState:function(){return _s(ms)},useDebugValue:Xs,useDeferredValue:function(e,t){var n=ls();return z===null?$s(n,e,t):ec(n,z.memoizedState,e,t)},useTransition:function(){var e=_s(ms)[0],t=ls().memoizedState;return[typeof e==`boolean`?e:ds(e),t]},useSyncExternalStore:vs,useId:sc,useHostTransitionStatus:oc,useFormState:Ls,useActionState:Ls,useOptimistic:function(e,t){var n=ls();return z===null?(n.baseState=e,[e,n.queue.dispatch]):Ts(n,z,e,t)},useMemoCache:ps,useCacheRefresh:cc,useEffectEvent:Gs};function xc(e,t,n,r){t=e.memoizedState,n=n(r,t),n=n==null?t:C({},t,n),e.memoizedState=n,e.lanes===0&&(e.updateQueue.baseState=n)}var Sc={enqueueSetState:function(e,t,n){e=e._reactInternals;var r=jd(),i=bo(r);i.payload=t,n!=null&&(i.callback=n),t=xo(e,i,r),t!==null&&(Pd(t,e,r),So(t,e,r))},enqueueReplaceState:function(e,t,n){e=e._reactInternals;var r=jd(),i=bo(r);i.tag=1,i.payload=t,n!=null&&(i.callback=n),t=xo(e,i,r),t!==null&&(Pd(t,e,r),So(t,e,r))},enqueueForceUpdate:function(e,t){e=e._reactInternals;var n=jd(),r=bo(n);r.tag=2,t!=null&&(r.callback=t),t=xo(e,r,n),t!==null&&(Pd(t,e,n),So(t,e,n))}};function Cc(e,t,n,r,i,a,o){return e=e.stateNode,typeof e.shouldComponentUpdate==`function`?e.shouldComponentUpdate(r,a,o):t.prototype&&t.prototype.isPureReactComponent?!Kr(n,r)||!Kr(i,a):!0}function wc(e,t,n,r){e=t.state,typeof t.componentWillReceiveProps==`function`&&t.componentWillReceiveProps(n,r),typeof t.UNSAFE_componentWillReceiveProps==`function`&&t.UNSAFE_componentWillReceiveProps(n,r),t.state!==e&&Sc.enqueueReplaceState(t,t.state,null)}function Tc(e,t){var n=t;if(`ref`in t)for(var r in n={},t)r!==`ref`&&(n[r]=t[r]);if(e=e.defaultProps)for(var i in n===t&&(n=C({},n)),e)n[i]===void 0&&(n[i]=e[i]);return n}function Ec(e){wi(e)}function Dc(e){console.error(e)}function Oc(e){wi(e)}function kc(e,t){try{var n=e.onUncaughtError;n(t.value,{componentStack:t.stack})}catch(e){setTimeout(function(){throw e})}}function Ac(e,t,n){try{var r=e.onCaughtError;r(n.value,{componentStack:n.stack,errorBoundary:t.tag===1?t.stateNode:null})}catch(e){setTimeout(function(){throw e})}}function jc(e,t,n){return n=bo(n),n.tag=3,n.payload={element:null},n.callback=function(){kc(e,t)},n}function Mc(e){return e=bo(e),e.tag=3,e}function Nc(e,t,n,r){var i=n.type.getDerivedStateFromError;if(typeof i==`function`){var a=r.value;e.payload=function(){return i(a)},e.callback=function(){Ac(t,n,r)}}var o=n.stateNode;o!==null&&typeof o.componentDidCatch==`function`&&(e.callback=function(){Ac(t,n,r),typeof i!=`function`&&(yd===null?yd=new Set([this]):yd.add(this));var e=r.stack;this.componentDidCatch(r.value,{componentStack:e===null?``:e})})}function Pc(e,t,n,r,i){if(n.flags|=32768,typeof r==`object`&&r&&typeof r.then==`function`){if(t=n.alternate,t!==null&&Ta(t,n,i,!0),n=Po.current,n!==null){switch(n.tag){case 31:case 13:case 19:return Fo===null?Kd():n.alternate===null&&Y===0&&(Y=3),n.flags&=-257,n.flags|=65536,n.lanes=i,r===to?n.flags|=16384:(t=n.updateQueue,t===null?n.updateQueue=new Set([r]):t.add(r),mf(e,r,i)),!1;case 22:return n.flags|=65536,r===to?n.flags|=16384:(t=n.updateQueue,t===null?(t={transitions:null,markerInstances:null,retryQueue:new Set([r])},n.updateQueue=t):(n=t.retryQueue,n===null?t.retryQueue=new Set([r]):n.add(r)),mf(e,r,i)),!1}throw Error(s(435,n.tag))}return mf(e,r,i),Kd(),!1}if(L)return t=Po.current,t===null?(r!==ua&&(t=Error(s(423),{cause:r}),_a(Ki(t,n))),e=e.current.alternate,e.flags|=65536,i&=-i,e.lanes|=i,r=Ki(r,n),i=jc(e.stateNode,r,i),Co(e,i),Y!==4&&(Y=2)):(!(t.flags&65536)&&(t.flags|=256),t.flags|=65536,t.lanes=i,r!==ua&&(e=Error(s(422),{cause:r}),_a(Ki(e,n)))),!1;var a=Error(s(520),{cause:r});if(a=Ki(a,n),fd===null?fd=[a]:fd.push(a),Y!==4&&(Y=2),t===null)return!0;r=Ki(r,n),n=t;do{switch(n.tag){case 3:return n.flags|=65536,e=i&-i,n.lanes|=e,e=jc(n.stateNode,r,e),Co(n,e),!1;case 1:if(t=n.type,a=n.stateNode,!(n.flags&128)&&(typeof t.getDerivedStateFromError==`function`||a!==null&&typeof a.componentDidCatch==`function`&&(yd===null||!yd.has(a))))return n.flags|=65536,i&=-i,n.lanes|=i,i=Mc(i),Nc(i,e,n,r),Co(n,i),!1;break;case 22:if(n.memoizedState!==null)return n.flags|=65536,!1}n=n.return}while(n!==null);return!1}var Fc=Error(s(461)),Ic=!1;function Lc(e,t,n,r){t.child=e===null?go(t,null,n,r):ho(t,e.child,n,r)}function Rc(e,t,n,r,i){n=n.render;var a=t.ref;if(`ref`in r){var o={};for(var s in r)s!==`ref`&&(o[s]=r[s])}else o=r;return Da(t),r=ts(e,t,n,o,a,i),s=as(),e!==null&&!Ic?(os(e,t,i),fl(e,t,i)):(L&&s&&ia(t),t.flags|=1,Lc(e,t,r,i),t.child)}function zc(e,t,n,r,i){if(e===null){var a=n.type;return typeof a==`function`&&!Li(a)&&a.defaultProps===void 0&&n.compare===null?(t.tag=15,t.type=a,Bc(e,t,a,r,i)):(e=Bi(n.type,null,r,t,t.mode,i),e.ref=t.ref,e.return=t,t.child=e)}if(a=e.child,!pl(e,i)){var o=a.memoizedProps;if(n=n.compare,n=n===null?Kr:n,n(o,r)&&e.ref===t.ref)return fl(e,t,i)}return t.flags|=1,e=Ri(a,r),e.ref=t.ref,e.return=t,t.child=e}function Bc(e,t,n,r,i){if(e!==null){var a=e.memoizedProps;if(Kr(a,r)&&e.ref===t.ref){if(Ic=!1,t.pendingProps=r=a,pl(e,i))e.flags&131072&&(Ic=!0);else return t.lanes=e.lanes,fl(e,t,i)}}return Jc(e,t,n,r,i)}function Vc(e,t,n,r){var i=r.children,a=e===null?null:e.memoizedState;if(e===null&&t.stateNode===null&&(t.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),r.mode===`hidden`){if(t.flags&128){if(a=a===null?n:a.baseLanes|n,e!==null){for(r=t.child=e.child,i=0;r!==null;)i=i|r.lanes|r.childLanes,r=r.sibling;r=i&~a}else r=0,t.child=null;return Uc(e,t,a,n,r)}if(n&536870912)t.memoizedState={baseLanes:0,cachePool:null},e!==null&&Xa(t,a===null?null:a.cachePool),a===null?Mo():jo(t,a),Ro(t);else return r=t.lanes=536870912,Uc(e,t,a===null?n:a.baseLanes|n,n,r)}else a===null?(e!==null&&Xa(t,null),Mo(),zo()):(Xa(t,a.cachePool),jo(t,a),zo(),t.memoizedState=null);return Lc(e,t,i,n),t.child}function Hc(e,t){return e!==null&&e.tag===22||t.stateNode!==null||(t.stateNode={_visibility:1,_pendingMarkers:null,_retryCache:null,_transitions:null}),t.sibling}function Uc(e,t,n,r,i){var a=Ya();return a=a===null?null:{parent:Pa._currentValue,pool:a},t.memoizedState={baseLanes:n,cachePool:a},e!==null&&Xa(t,null),Mo(),Ro(t),e!==null&&Ta(e,t,r,!0),t.childLanes=i,null}function Wc(e,t){return t=rl({mode:t.mode,children:t.children},e.mode),t.ref=e.ref,e.child=t,t.return=e,t}function Gc(e,t,n){return ho(t,e.child,null,n),e=Wc(t,t.pendingProps),e.flags|=2,Bo(t),t.memoizedState=null,e}function Kc(e,t,n){var r=t.pendingProps,i=!!(t.flags&128);if(t.flags&=-129,e===null){if(L){if(r.mode===`hidden`)return e=Wc(t,r),t.lanes=536870912,e.memoizedState={baseLanes:0,cachePool:null},Hc(null,e);if(Lo(t),(e=I)?(e=am(e,la),e=e!==null&&e.data===`&`?e:null,e!==null&&(t.memoizedState={dehydrated:e,treeContext:$i===null?null:{id:ea,overflow:ta},retryLane:536870912,hydrationErrors:null},n=Ui(e),n.return=t,t.child=n,sa=t,I=null)):e=null,e===null)throw da(t);return t.lanes=536870912,null}return Wc(t,r)}var a=e.memoizedState;if(a!==null){var o=a.dehydrated;if(Lo(t),i){if(t.flags&256)t.flags&=-257,t=Gc(e,t,n);else if(t.memoizedState!==null)t.child=e.child,t.flags|=128,t=null;else throw Error(s(558))}else if(Ic||Ta(e,t,n,!1),i=(n&e.childLanes)!==0,Ic||i){if(ko.current===null){if(r=G,r!==null&&(o=St(r,n),o!==0&&o!==a.retryLane))throw a.retryLane=o,ji(e,o),Pd(r,e,o),Fc;Kd()}t=Gc(e,t,n)}else e=a.treeContext,I=lm(o.nextSibling),sa=t,L=!0,ca=null,la=!1,e!==null&&oa(t,e),t=Wc(t,r),t.flags|=134221824;return t}return e=Ri(e.child,{mode:r.mode,children:r.children}),e.ref=t.ref,t.child=e,e.return=t,e}function qc(e,t){var n=t.ref;if(n===null)e!==null&&e.ref!==null&&(t.flags|=4194816);else{if(typeof n!=`function`&&typeof n!=`object`)throw Error(s(284));(e===null||e.ref!==n)&&(t.flags|=4194816)}}function Jc(e,t,n,r,i){return Da(t),n=ts(e,t,n,r,void 0,i),r=as(),e!==null&&!Ic?(os(e,t,i),fl(e,t,i)):(L&&r&&ia(t),t.flags|=1,Lc(e,t,n,i),t.child)}function Yc(e,t,n,r,i,a){return Da(t),t.updateQueue=null,n=rs(t,r,n,i),ns(e),r=as(),e!==null&&!Ic?(os(e,t,a),fl(e,t,a)):(L&&r&&ia(t),t.flags|=1,Lc(e,t,n,a),t.child)}function Xc(e,t,n,r,i){if(Da(t),t.stateNode===null){var a=Pi,o=n.contextType;typeof o==`object`&&o&&(a=Oa(o)),a=new n(r,a),t.memoizedState=a.state!==null&&a.state!==void 0?a.state:null,a.updater=Sc,t.stateNode=a,a._reactInternals=t,a=t.stateNode,a.props=r,a.state=t.memoizedState,a.refs={},vo(t),o=n.contextType,a.context=typeof o==`object`&&o?Oa(o):Pi,a.state=t.memoizedState,o=n.getDerivedStateFromProps,typeof o==`function`&&(xc(t,n,o,r),a.state=t.memoizedState),typeof n.getDerivedStateFromProps==`function`||typeof a.getSnapshotBeforeUpdate==`function`||typeof a.UNSAFE_componentWillMount!=`function`&&typeof a.componentWillMount!=`function`||(o=a.state,typeof a.componentWillMount==`function`&&a.componentWillMount(),typeof a.UNSAFE_componentWillMount==`function`&&a.UNSAFE_componentWillMount(),o!==a.state&&Sc.enqueueReplaceState(a,a.state,null),Eo(t,r,a,i),To(),a.state=t.memoizedState),typeof a.componentDidMount==`function`&&(t.flags|=4194308),r=!0}else if(e===null){a=t.stateNode;var s=t.memoizedProps,c=Tc(n,s);a.props=c;var l=a.context,u=n.contextType;o=Pi,typeof u==`object`&&u&&(o=Oa(u));var d=n.getDerivedStateFromProps;u=typeof d==`function`||typeof a.getSnapshotBeforeUpdate==`function`,s=t.pendingProps!==s,u||typeof a.UNSAFE_componentWillReceiveProps!=`function`&&typeof a.componentWillReceiveProps!=`function`||(s||l!==o)&&wc(t,a,r,o),_o=!1;var f=t.memoizedState;a.state=f,Eo(t,r,a,i),To(),l=t.memoizedState,s||f!==l||_o?(typeof d==`function`&&(xc(t,n,d,r),l=t.memoizedState),(c=_o||Cc(t,n,c,r,f,l,o))?(u||typeof a.UNSAFE_componentWillMount!=`function`&&typeof a.componentWillMount!=`function`||(typeof a.componentWillMount==`function`&&a.componentWillMount(),typeof a.UNSAFE_componentWillMount==`function`&&a.UNSAFE_componentWillMount()),typeof a.componentDidMount==`function`&&(t.flags|=4194308)):(typeof a.componentDidMount==`function`&&(t.flags|=4194308),t.memoizedProps=r,t.memoizedState=l),a.props=r,a.state=l,a.context=o,r=c):(typeof a.componentDidMount==`function`&&(t.flags|=4194308),r=!1)}else{a=t.stateNode,yo(e,t),o=t.memoizedProps,u=Tc(n,o),a.props=u,d=t.pendingProps,f=a.context,l=n.contextType,c=Pi,typeof l==`object`&&l&&(c=Oa(l)),s=n.getDerivedStateFromProps,(l=typeof s==`function`||typeof a.getSnapshotBeforeUpdate==`function`)||typeof a.UNSAFE_componentWillReceiveProps!=`function`&&typeof a.componentWillReceiveProps!=`function`||(o!==d||f!==c)&&wc(t,a,r,c),_o=!1,f=t.memoizedState,a.state=f,Eo(t,r,a,i),To();var p=t.memoizedState;o!==d||f!==p||_o||e!==null&&e.dependencies!==null&&Ea(e.dependencies)?(typeof s==`function`&&(xc(t,n,s,r),p=t.memoizedState),(u=_o||Cc(t,n,u,r,f,p,c)||e!==null&&e.dependencies!==null&&Ea(e.dependencies))?(l||typeof a.UNSAFE_componentWillUpdate!=`function`&&typeof a.componentWillUpdate!=`function`||(typeof a.componentWillUpdate==`function`&&a.componentWillUpdate(r,p,c),typeof a.UNSAFE_componentWillUpdate==`function`&&a.UNSAFE_componentWillUpdate(r,p,c)),typeof a.componentDidUpdate==`function`&&(t.flags|=4),typeof a.getSnapshotBeforeUpdate==`function`&&(t.flags|=1024)):(typeof a.componentDidUpdate!=`function`||o===e.memoizedProps&&f===e.memoizedState||(t.flags|=4),typeof a.getSnapshotBeforeUpdate!=`function`||o===e.memoizedProps&&f===e.memoizedState||(t.flags|=1024),t.memoizedProps=r,t.memoizedState=p),a.props=r,a.state=p,a.context=c,r=u):(typeof a.componentDidUpdate!=`function`||o===e.memoizedProps&&f===e.memoizedState||(t.flags|=4),typeof a.getSnapshotBeforeUpdate!=`function`||o===e.memoizedProps&&f===e.memoizedState||(t.flags|=1024),r=!1)}return a=r,qc(e,t),r=!!(t.flags&128),a||r?(a=t.stateNode,n=r&&typeof n.getDerivedStateFromError!=`function`?null:a.render(),t.flags|=1,e!==null&&r?(t.child=ho(t,e.child,null,i),t.child=ho(t,null,n,i)):Lc(e,t,n,i),t.memoizedState=a.state,e=t.child):e=fl(e,t,i),e}function Zc(e,t,n,r){return ha(),t.flags|=256,Lc(e,t,n,r),t.child}var Qc={dehydrated:null,treeContext:null,retryLane:0,hydrationErrors:null};function $c(e){return{baseLanes:e,cachePool:Za()}}function el(e,t,n){return e=e===null?0:e.childLanes&~n,t&&(e|=ud),e}function tl(e,t,n){var r=t.pendingProps,i=!1,a=!!(t.flags&128),o;if((o=a)||(o=e!==null&&e.memoizedState===null?!1:!!(Vo.current&2)),o&&(i=!0,t.flags&=-129),o=!!(t.flags&32),t.flags&=-33,e===null){if(L){if(i?Io(t):zo(),(e=I)?(e=am(e,la),e=e!==null&&e.data!==`&`?e:null,e!==null&&(t.memoizedState={dehydrated:e,treeContext:$i===null?null:{id:ea,overflow:ta},retryLane:536870912,hydrationErrors:null},n=Ui(e),n.return=t,t.child=n,sa=t,I=null)):e=null,e===null)throw da(t);return t.lanes=sm(e)?32:536870912,null}return a=r.children,r=r.fallback,i?(zo(),i=t.mode,a=rl({mode:`hidden`,children:a},i),r=Vi(r,i,n,null),a.return=t,r.return=t,a.sibling=r,t.child=a,r=t.child,r.memoizedState=$c(n),r.childLanes=el(e,o,n),t.memoizedState=Qc,Hc(null,r)):(Io(t),nl(t,a))}var s=e.memoizedState;if(s!==null){var c=s.dehydrated;if(c!==null)return al(e,t,a,o,r,c,s,n)}return i?(zo(),i=r.fallback,a=t.mode,s=e.child,c=s.sibling,r=Ri(s,{mode:`hidden`,children:r.children}),r.subtreeFlags=s.subtreeFlags&1206910976,c===null?(i=Vi(i,a,n,null),i.flags|=2):i=Ri(c,i),i.return=t,r.return=t,r.sibling=i,t.child=r,Hc(null,r),r=t.child,i=e.child.memoizedState,i===null?i=$c(n):(a=i.cachePool,a===null?a=Za():(s=Pa._currentValue,a=a.parent===s?a:{parent:s,pool:s}),i={baseLanes:i.baseLanes|n,cachePool:a}),r.memoizedState=i,r.childLanes=el(e,o,n),t.memoizedState=Qc,Hc(e.child,r)):(Io(t),n=e.child,e=n.sibling,n=Ri(n,{mode:`visible`,children:r.children}),n.return=t,n.sibling=null,e!==null&&(o=t.deletions,o===null?(t.deletions=[e],t.flags|=16):o.push(e)),t.child=n,t.memoizedState=null,n)}function nl(e,t){return t=rl({mode:`visible`,children:t},e.mode),t.return=e,e.child=t}function rl(e,t){return e=Ii(22,e,null,t),e.lanes=0,e}function il(e,t,n){return ho(t,e.child,null,n),e=nl(t,t.pendingProps.children),e.flags|=2,t.memoizedState=null,e}function al(e,t,n,r,i,a,o,c){if(n)return t.flags&256?(Io(t),t.flags&=-257,il(e,t,c)):t.memoizedState===null?(zo(),a=i.fallback,o=t.mode,i=rl({mode:`visible`,children:i.children},o),a=Vi(a,o,c,null),a.flags|=2,i.return=t,a.return=t,i.sibling=a,t.child=i,ho(t,e.child,null,c),i=t.child,i.memoizedState=$c(c),i.childLanes=el(e,r,c),t.memoizedState=Qc,Hc(null,i)):(zo(),t.child=e.child,t.flags|=128,null);if(Io(t),sm(a)){if(r=a.nextSibling&&a.nextSibling.dataset,r)var l=r.dgst;return r=l,r!==``&&(i=Error(s(419)),i.stack=``,i.digest=r,_a({value:i,source:null,stack:null})),il(e,t,c)}if(Ic||Ta(e,t,c,!1),r=(c&e.childLanes)!==0,Ic||r){if(ko.current!==null)return il(e,t,c);if(r=G,r!==null&&(i=St(r,c),i!==0&&i!==o.retryLane))throw o.retryLane=i,ji(e,i),Pd(r,e,i),Fc;return om(a)||Kd(),il(e,t,c)}return om(a)?(t.flags|=192,t.child=e.child,null):(e=o.treeContext,I=lm(a.nextSibling),sa=t,L=!0,ca=null,la=!1,e!==null&&oa(t,e),t=nl(t,i.children),t.flags|=134221824,t)}function ol(e,t,n){e.lanes|=t;var r=e.alternate;r!==null&&(r.lanes|=t),Ca(e.return,t,n)}function sl(e){for(var t=null;e!==null;){var n=e.alternate;n!==null&&Wo(n)===null&&(t=e),e=e.sibling}return t}function cl(e,t,n,r,i,a){var o=e.memoizedState;o===null?e.memoizedState={isBackwards:t,rendering:null,renderingStartTime:0,last:r,tail:n,tailMode:i,treeForkCount:a}:(o.isBackwards=t,o.rendering=null,o.renderingStartTime=0,o.last=r,o.tail=n,o.tailMode=i,o.treeForkCount=a)}function ll(e){var t=e.child;for(e.child=null;t!==null;){var n=t.sibling;t.sibling=e.child,e.child=t,t=n}}function ul(e,t,n){var r=t.pendingProps,i=r.revealOrder,a=r.tail;r=r.children;var o=Vo.current;if(t.flags&128)return Ho(t,o),null;var s=!!(o&2);if(s?(o=o&1|2,t.flags|=128):o&=1,Ho(t,o),i===`backwards`&&e!==null?(ll(e),Lc(e,t,r,n),ll(e)):Lc(e,t,r,n),r=L?Xi:0,!s&&e!==null&&e.flags&128)a:for(e=t.child;e!==null;){if(e.tag===13)e.memoizedState!==null&&ol(e,n,t);else if(e.tag===19)ol(e,n,t);else if(e.child!==null){e.child.return=e,e=e.child;continue}if(e===t)break a;for(;e.sibling===null;){if(e.return===null||e.return===t)break a;e=e.return}e.sibling.return=e.return,e=e.sibling}switch(i){case`backwards`:n=sl(t.child),n===null?(i=t.child,t.child=null):(i=n.sibling,n.sibling=null,ll(t)),cl(t,!0,i,null,a,r);break;case`unstable_legacy-backwards`:for(n=null,i=t.child,t.child=null;i!==null;){if(e=i.alternate,e!==null&&Wo(e)===null){t.child=i;break}e=i.sibling,i.sibling=n,n=i,i=e}cl(t,!0,n,null,a,r);break;case`together`:cl(t,!1,null,null,void 0,r);break;case`independent`:t.memoizedState=null;break;default:n=sl(t.child),n===null?(i=t.child,t.child=null):(i=n.sibling,n.sibling=null),cl(t,!1,i,n,a,r)}return t.child}function dl(e,t,n){var r=t.pendingProps;return xa(t,t.type,r.value),Lc(e,t,r.children,n),t.child}function fl(e,t,n){if(e!==null&&(t.dependencies=e.dependencies),sd|=t.lanes,(n&t.childLanes)===0){if(e!==null){if(Ta(e,t,n,!1),(n&t.childLanes)===0)return null}else return null}if(e!==null&&t.child!==e.child)throw Error(s(153));if(t.child!==null){for(e=t.child,n=Ri(e,e.pendingProps),t.child=n,n.return=t;e.sibling!==null;)e=e.sibling,n=n.sibling=Ri(e,e.pendingProps),n.return=t;n.sibling=null}return t.child}function pl(e,t){return(e.lanes&t)!==0||(e=e.dependencies,!!(e!==null&&Ea(e)))}function ml(e,t,n){switch(t.tag){case 3:Ne(t,t.stateNode.containerInfo),xa(t,Pa,e.memoizedState.cache),ha();break;case 27:case 5:Fe(t);break;case 4:Ne(t,t.stateNode.containerInfo);break;case 10:xa(t,t.type,t.memoizedProps.value);break;case 31:if(t.memoizedState!==null)return t.flags|=128,Lo(t),null;break;case 13:var r=t.memoizedState;if(r!==null){if(r.dehydrated!==null)return Io(t),t.flags|=128,null;r=Ta(e,t,n,!1);var i=t.child.childLanes;return r||(n&i)!==0?tl(e,t,n):(Io(t),e=fl(e,t,n),e===null?null:e.sibling)}Io(t);break;case 19:if(t.flags&128)return ul(e,t,n);if(i=!!(e.flags&128),r=(n&t.childLanes)!==0,r||=(Ta(e,t,n,!1),(n&t.childLanes)!==0),i){if(r)return ul(e,t,n);t.flags|=128}if(i=t.memoizedState,i!==null&&(i.rendering=null,i.tail=null,i.lastEffect=null),Ho(t,Vo.current),r)break;return null;case 22:return t.lanes=0,Vc(e,t,n,t.pendingProps);case 24:xa(t,Pa,e.memoizedState.cache)}return fl(e,t,n)}function hl(e,t,n){if(e!==null){if(e.memoizedProps!==t.pendingProps)Ic=!0;else{if(!pl(e,n)&&!(t.flags&128))return Ic=!1,ml(e,t,n);Ic=!!(e.flags&131072)}}else Ic=!1,L&&t.flags&1048576&&ra(t,Xi,t.index);switch(t.lanes=0,t.tag){case 16:a:{var r=t.pendingProps;if(e=io(t.elementType),t.type=e,typeof e==`function`)Li(e)?(r=Tc(e,r),t.tag=1,t=Xc(null,t,e,r,n)):(t.tag=0,t=Jc(null,t,e,r,n));else{if(e!=null){var i=e.$$typeof;if(i===w){t.tag=11,t=Rc(null,t,e,r,n);break a}if(i===me){t.tag=14,t=zc(null,t,e,r,n);break a}if(i===de){t.tag=10,t.type=e,t=dl(null,t,n);break a}}throw t=we(e)||e,Error(s(306,t,``))}}return t;case 0:return Jc(e,t,t.type,t.pendingProps,n);case 1:return r=t.type,i=Tc(r,t.pendingProps),Xc(e,t,r,i,n);case 3:a:{if(Ne(t,t.stateNode.containerInfo),e===null)throw Error(s(387));r=t.pendingProps;var a=t.memoizedState;i=a.element,yo(e,t),Eo(t,r,null,n);var o=t.memoizedState;if(r=o.cache,xa(t,Pa,r),r!==a.cache&&wa(t,[Pa],n,!0),To(),r=o.element,a.isDehydrated){if(a={element:r,isDehydrated:!1,cache:o.cache},t.updateQueue.baseState=a,t.memoizedState=a,t.flags&256){t=Zc(e,t,r,n);break a}if(r!==i){i=Ki(Error(s(424)),t),_a(i),t=Zc(e,t,r,n);break a}switch(e=t.stateNode.containerInfo,e.nodeType){case 9:e=e.body;break;default:e=e.nodeName===`HTML`?e.ownerDocument.body:e}for(I=lm(e.firstChild),sa=t,L=!0,ca=null,la=!0,n=go(t,null,r,n),t.child=n;n;)n.flags=n.flags&-3|134221824,n=n.sibling}else{if(ha(),r===i){t=fl(e,t,n);break a}Lc(e,t,r,n)}t=t.child}return t;case 26:return qc(e,t),e===null?(n=Nm(t.type,null,t.pendingProps,null))?t.memoizedState=n:L||(t.stateNode=fp(t.type,t.pendingProps,je.current,t)):t.memoizedState=Nm(t.type,e.memoizedProps,t.pendingProps,e.memoizedState),null;case 27:return Fe(t),e===null&&L&&(r=t.stateNode=hm(t.type,t.pendingProps,je.current),sa=t,la=!0,i=I,Sp(t.type)?(um=i,I=lm(r.firstChild)):I=i),Lc(e,t,t.pendingProps.children,n),qc(e,t),e===null&&(t.flags|=4194304),t.child;case 5:return e===null&&L&&((i=r=I)&&(r=rm(r,t.type,t.pendingProps,la),r===null?i=!1:(t.stateNode=r,sa=t,I=lm(r.firstChild),la=!1,i=!0)),i||da(t)),Fe(t),i=t.type,a=t.pendingProps,o=e===null?null:e.memoizedProps,r=a.children,pp(i,a)?r=null:o!==null&&pp(i,o)&&(t.flags|=32),t.memoizedState!==null&&(i=ts(e,t,is,null,null,n),sh._currentValue=i),qc(e,t),Lc(e,t,r,n),t.child;case 6:return e===null&&L&&((e=n=I)&&(n=im(n,t.pendingProps,la),n===null?e=!1:(t.stateNode=n,sa=t,I=null,e=!0)),e||da(t)),null;case 13:return tl(e,t,n);case 4:return Ne(t,t.stateNode.containerInfo),r=t.pendingProps,e===null?t.child=ho(t,null,r,n):Lc(e,t,r,n),t.child;case 11:return Rc(e,t,t.type,t.pendingProps,n);case 7:return r=t.pendingProps,qc(e,t),Lc(e,t,r,n),t.child;case 8:return Lc(e,t,t.pendingProps.children,n),t.child;case 12:return Lc(e,t,t.pendingProps.children,n),t.child;case 10:return dl(e,t,n);case 9:return i=t.type._context,r=t.pendingProps.children,Da(t),i=Oa(i),r=r(i),t.flags|=1,Lc(e,t,r,n),t.child;case 14:return zc(e,t,t.type,t.pendingProps,n);case 15:return Bc(e,t,t.type,t.pendingProps,n);case 19:return ul(e,t,n);case 31:return Kc(e,t,n);case 22:return Vc(e,t,n,t.pendingProps);case 24:return Da(t),r=Oa(Pa),e===null?(i=Ya(),i===null&&(i=G,a=Fa(),i.pooledCache=a,a.refCount++,a!==null&&(i.pooledCacheLanes|=n),i=a),t.memoizedState={parent:r,cache:i},vo(t),xa(t,Pa,i)):((e.lanes&n)!==0&&(yo(e,t),Eo(t,null,null,n),To()),i=e.memoizedState,a=t.memoizedState,i.parent===r?(r=a.cache,xa(t,Pa,r),r!==i.cache&&wa(t,[Pa],n,!0)):(i={parent:r,cache:r},t.memoizedState=i,t.lanes===0&&(t.memoizedState=t.updateQueue.baseState=i),xa(t,Pa,r))),Lc(e,t,t.pendingProps.children,n),t.child;case 30:return t.stateNode===null&&(t.stateNode={autoName:null,paired:null,clones:null,ref:null}),r=t.pendingProps,r.name!=null&&r.name!==`auto`?t.flags|=e===null?18882560:18874368:L&&ia(t),e!==null&&e.memoizedProps.name!==r.name?t.flags|=4194816:qc(e,t),Lc(e,t,r.children,n),t.child;case 29:throw t.pendingProps}throw Error(s(156,t.tag))}function gl(e){e.flags|=4}function _l(e,t,n,r,i){var a;if((a=!!(e.mode&32))&&(a=n===null?Jm(t,r):Jm(t,r)&&(r.src!==n.src||r.srcSet!==n.srcSet)),a){if(e.flags|=16777216,(i&335544128)===i){if(e.stateNode.complete)e.flags|=8192;else if(Ud())e.flags|=8192;else throw ao=to,$a}}else e.flags&=-16777217}function vl(e,t){if(t.type!==`stylesheet`||t.state.loading&4)e.flags&=-16777217;else if(e.flags|=16777216,!Ym(t)){if(Ud())e.flags|=8192;else throw ao=to,$a}}function yl(e,t){t!==null&&(e.flags|=4),e.flags&16384&&(t=e.tag===22?536870912:gt(),e.lanes|=t,dd|=t)}function bl(e,t){if(!L)switch(e.tailMode){case`visible`:break;case`collapsed`:for(var n=e.tail,r=null;n!==null;)n.alternate!==null&&(r=n),n=n.sibling;r===null?t||e.tail===null?e.tail=null:e.tail.sibling=null:r.sibling=null;break;default:for(t=e.tail,n=null;t!==null;)t.alternate!==null&&(n=t),t=t.sibling;n===null?e.tail=null:n.sibling=null}}function V(e){var t=e.alternate!==null&&e.alternate.child===e.child,n=0,r=0;if(t)for(var i=e.child;i!==null;)n|=i.lanes|i.childLanes,r|=i.subtreeFlags&1206910976,r|=i.flags&1206910976,i.return=e,i=i.sibling;else for(i=e.child;i!==null;)n|=i.lanes|i.childLanes,r|=i.subtreeFlags,r|=i.flags,i.return=e,i=i.sibling;return e.subtreeFlags|=r,e.childLanes=n,t}function xl(e,t,n){var r=t.pendingProps;switch(aa(t),t.tag){case 16:case 15:case 0:case 11:case 7:case 8:case 12:case 9:case 14:return V(t),null;case 1:return V(t),null;case 3:return n=t.stateNode,r=null,e!==null&&(r=e.memoizedState.cache),t.memoizedState.cache!==r&&(t.flags|=2048),Sa(Pa),Pe(),n.pendingContext&&(n.context=n.pendingContext,n.pendingContext=null),(e===null||e.child===null)&&(ma(t)?gl(t):e===null||e.memoizedState.isDehydrated&&!(t.flags&256)||(t.flags|=1024,ga())),V(t),null;case 26:var i=t.type,a=t.memoizedState;return e===null?(gl(t),a===null?(V(t),_l(t,i,null,r,n)):(V(t),vl(t,a))):a?a===e.memoizedState?(V(t),t.flags&=-16777217):(gl(t),V(t),vl(t,a)):(e=e.memoizedProps,e!==r&&gl(t),V(t),_l(t,i,e,r,n)),null;case 27:if(Ie(t),n=je.current,i=t.type,e!==null&&t.stateNode!=null)e.memoizedProps!==r&&gl(t);else{if(!r){if(t.stateNode===null)throw Error(s(166));return V(t),t.subtreeFlags&=-33554433,null}e=ke.current,ma(t)?fa(t,e):(e=hm(i,r,n),t.stateNode=e,gl(t))}return V(t),t.subtreeFlags&=-33554433,null;case 5:if(Ie(t),i=t.type,e!==null&&t.stateNode!=null)e.memoizedProps!==r&&gl(t);else{if(!r){if(t.stateNode===null)throw Error(s(166));return V(t),t.subtreeFlags&=-33554433,null}if(a=ke.current,ma(t))fa(t,a);else{var o=lp(je.current);switch(a){case 1:a=o.createElementNS(`http://www.w3.org/2000/svg`,i);break;case 2:a=o.createElementNS(`http://www.w3.org/1998/Math/MathML`,i);break;default:switch(i){case`svg`:a=o.createElementNS(`http://www.w3.org/2000/svg`,i);break;case`math`:a=o.createElementNS(`http://www.w3.org/1998/Math/MathML`,i);break;case`script`:a=o.createElement(`div`),a.innerHTML=`<script><\\/script>`,a=a.removeChild(a.firstChild);break;case`select`:a=typeof r.is==`string`?o.createElement(`select`,{is:r.is}):o.createElement(`select`),r.multiple?a.multiple=!0:r.size&&(a.size=r.size);break;default:a=typeof r.is==`string`?o.createElement(i,{is:r.is}):o.createElement(i)}}a[Ot]=t,a[kt]=r;a:for(o=t.child;o!==null;){if(o.tag===5||o.tag===6)a.appendChild(o.stateNode);else if(o.tag!==4&&o.tag!==27&&o.child!==null){o.child.return=o,o=o.child;continue}if(o===t)break a;for(;o.sibling===null;){if(o.return===null||o.return===t)break a;o=o.return}o.sibling.return=o.return,o=o.sibling}t.stateNode=a;a:switch(np(a,i,r),i){case`button`:case`input`:case`select`:case`textarea`:r=!!r.autoFocus;break a;case`img`:r=!0;break a;default:r=!1}r&&gl(t)}}return V(t),t.subtreeFlags&=-33554433,_l(t,t.type,e===null?null:e.memoizedProps,t.pendingProps,n),null;case 6:if(e&&t.stateNode!=null)e.memoizedProps!==r&&gl(t);else{if(typeof r!=`string`&&t.stateNode===null)throw Error(s(166));if(e=je.current,ma(t)){if(e=t.stateNode,n=t.memoizedProps,r=null,i=sa,i!==null)switch(i.tag){case 27:case 5:r=i.memoizedProps}e[Ot]=t,e=!!(e.nodeValue===n||r!==null&&!0===r.suppressHydrationWarning||ep(e.nodeValue,n)),e||da(t,!0)}else e=lp(e).createTextNode(r),e[Ot]=t,t.stateNode=e}return V(t),null;case 31:if(n=t.memoizedState,e===null||e.memoizedState!==null){if(r=ma(t),n!==null){if(e===null){if(!r)throw Error(s(318));if(e=t.memoizedState,e=e===null?null:e.dehydrated,!e)throw Error(s(557));e[Ot]=t}else ha(),!(t.flags&128)&&(t.memoizedState=null),t.flags|=4;V(t),e=!1}else n=ga(),e!==null&&e.memoizedState!==null&&(e.memoizedState.hydrationErrors=n),e=!0;if(!e)return t.flags&256?(Bo(t),t):(Bo(t),null);if(t.flags&128)throw Error(s(558))}return V(t),null;case 13:if(r=t.memoizedState,e===null||e.memoizedState!==null&&e.memoizedState.dehydrated!==null){if(i=ma(t),r!==null&&r.dehydrated!==null){if(e===null){if(!i)throw Error(s(318));if(i=t.memoizedState,i=i===null?null:i.dehydrated,!i)throw Error(s(317));i[Ot]=t}else ha(),!(t.flags&128)&&(t.memoizedState=null),t.flags|=4;V(t),i=!1}else i=ga(),e!==null&&e.memoizedState!==null&&(e.memoizedState.hydrationErrors=i),i=!0;if(!i)return t.flags&256?(Bo(t),t):(Bo(t),null)}return Bo(t),t.flags&128?(t.lanes=n,t):(n=r!==null,e=e!==null&&e.memoizedState!==null,n&&(r=t.child,i=null,r.alternate!==null&&r.alternate.memoizedState!==null&&r.alternate.memoizedState.cachePool!==null&&(i=r.alternate.memoizedState.cachePool.pool),a=null,r.memoizedState!==null&&r.memoizedState.cachePool!==null&&(a=r.memoizedState.cachePool.pool),a!==i&&(r.flags|=2048)),n!==e&&n&&(t.child.flags|=8192),yl(t,t.updateQueue),V(t),null);case 4:return Pe(),e===null&&Wf(t.stateNode.containerInfo),t.flags|=67108864,V(t),null;case 10:return Sa(t.type),V(t),null;case 19:if(Uo(t),r=t.memoizedState,r===null)return V(t),null;if(i=!!(t.flags&128),a=r.rendering,a===null){if(i)bl(r,!1);else{if(Y!==0||e!==null&&e.flags&128)for(e=t.child;e!==null;){if(a=Wo(e),a!==null){for(t.flags|=128,bl(r,!1),e=a.updateQueue,t.updateQueue=e,yl(t,e),t.subtreeFlags=0,e=n,n=t.child;n!==null;)zi(n,e),n=n.sibling;return Ho(t,Vo.current&1|2),L&&na(t,r.treeForkCount),t.child}e=e.sibling}r.tail!==null&&qe()>_d&&(t.flags|=128,i=!0,bl(r,!1),t.lanes=4194304)}}else{if(!i){if(e=Wo(a),e!==null){if(t.flags|=128,i=!0,e=e.updateQueue,t.updateQueue=e,yl(t,e),bl(r,!0),r.tail===null&&r.tailMode!==`collapsed`&&r.tailMode!==`visible`&&!a.alternate&&!L)return V(t),null}else 2*qe()-r.renderingStartTime>_d&&n!==536870912&&(t.flags|=128,i=!0,bl(r,!1),t.lanes=4194304)}r.isBackwards?(a.sibling=t.child,t.child=a):(e=r.last,e===null?t.child=a:e.sibling=a,r.last=a)}if(r.tail!==null){e=r.tail;a:{for(n=e;n!==null;){if(n.alternate!==null){n=!1;break a}n=n.sibling}n=!0}return r.rendering=e,r.tail=e.sibling,r.renderingStartTime=qe(),e.sibling=null,a=Vo.current,a=i?a&1|2:a&1,r.tailMode===`visible`||r.tailMode===`collapsed`||!n||L?Ho(t,a):(n=a,k(Po,t),k(Vo,n),Fo===null&&(Fo=t)),L&&na(t,r.treeForkCount),e}return V(t),null;case 22:case 23:return Bo(t),No(),r=t.memoizedState!==null,e===null?r&&(t.flags|=8192):e.memoizedState!==null!==r&&(t.flags|=8192),r?n&536870912&&!(t.flags&128)&&(V(t),t.subtreeFlags&6&&(t.flags|=8192)):V(t),n=t.updateQueue,n!==null&&yl(t,n.retryQueue),n=null,e!==null&&e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(n=e.memoizedState.cachePool.pool),r=null,t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(r=t.memoizedState.cachePool.pool),r!==n&&(t.flags|=2048),e!==null&&O(Ja),null;case 24:return n=null,e!==null&&(n=e.memoizedState.cache),t.memoizedState.cache!==n&&(t.flags|=2048),Sa(Pa),V(t),null;case 25:return null;case 30:return t.flags|=33554432,V(t),null}throw Error(s(156,t.tag))}function Sl(e,t){switch(aa(t),t.tag){case 1:return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 3:return Sa(Pa),Pe(),e=t.flags,e&65536&&!(e&128)?(t.flags=e&-65537|128,t):null;case 26:case 27:case 5:return Ie(t),null;case 31:if(t.memoizedState!==null){if(Bo(t),t.alternate===null)throw Error(s(340));ha()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 13:if(Bo(t),e=t.memoizedState,e!==null&&e.dehydrated!==null){if(t.alternate===null)throw Error(s(340));ha()}return e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 19:return Uo(t),e=t.flags,e&65536?(t.flags=e&-65537|128,e=t.memoizedState,e!==null&&(e.rendering=null,e.tail=null),t.flags|=4,t):null;case 4:return Pe(),null;case 10:return Sa(t.type),null;case 22:case 23:return Bo(t),No(),e!==null&&O(Ja),e=t.flags,e&65536?(t.flags=e&-65537|128,t):null;case 24:return Sa(Pa),null;case 25:return null;default:return null}}function Cl(e,t){switch(aa(t),t.tag){case 3:Sa(Pa),Pe();break;case 26:case 27:case 5:Ie(t);break;case 4:Pe();break;case 31:t.memoizedState!==null&&Bo(t);break;case 13:Bo(t);break;case 19:Uo(t);break;case 10:Sa(t.type);break;case 22:case 23:Bo(t),No(),e!==null&&O(Ja);break;case 24:Sa(Pa)}}function wl(e,t){try{var n=t.updateQueue,r=n===null?null:n.lastEffect;if(r!==null){var i=r.next;n=i;do{if((n.tag&e)===e){r=void 0;var a=n.create,o=n.inst;r=a(),o.destroy=r}n=n.next}while(n!==i)}}catch(e){Z(t,t.return,e)}}function Tl(e,t,n){try{var r=t.updateQueue,i=r===null?null:r.lastEffect;if(i!==null){var a=i.next;r=a;do{if((r.tag&e)===e){var o=r.inst,s=o.destroy;if(s!==void 0){o.destroy=void 0,i=t;var c=n,l=s;try{l()}catch(e){Z(i,c,e)}}}r=r.next}while(r!==a)}}catch(e){Z(t,t.return,e)}}function El(e){var t=e.updateQueue;if(t!==null){var n=e.stateNode;try{Oo(t,n)}catch(t){Z(e,e.return,t)}}}function Dl(e,t,n){n.props=Tc(e.type,e.memoizedProps),n.state=e.memoizedState;try{n.componentWillUnmount()}catch(n){Z(e,t,n)}}function Ol(e,t){try{var n=e.ref;if(n!==null){switch(e.tag){case 26:case 27:case 5:var r=e.stateNode;break;case 30:var i=e.stateNode,a=xi(e.memoizedProps,i);(i.ref===null||i.ref.name!==a)&&(i.ref=Pp(a)),r=i.ref;break;case 7:if(e.stateNode===null){var o=new Fp(e);h(e.child,!1,Qp,o,void 0,void 0),e.stateNode=o}r=e.stateNode;break;default:r=e.stateNode}typeof n==`function`?e.refCleanup=n(r):n.current=r}}catch(n){Z(e,t,n)}}function kl(e,t){var n=e.ref,r=e.refCleanup;if(n!==null){if(typeof r==`function`)try{r()}catch(n){Z(e,t,n)}finally{e.refCleanup=null,e=e.alternate,e!=null&&(e.refCleanup=null)}else if(typeof n==`function`)try{n(null)}catch(n){Z(e,t,n)}else n.current=null}}function Al(e,t){if((e.tag===5||e.tag===27||e.tag===6)&&e.alternate===null&&t!==null)for(var n=0;n<t.length;n++)em(e.stateNode,t[n])}function jl(e){for(var t=e.return;t!==null&&(Pl(t)&&em(e.stateNode,t.stateNode),!Nl(t));)t=t.return}function Ml(e){for(var t=e.return;t!==null&&(Pl(t)&&tm(e.stateNode,t.stateNode),!Nl(t));)t=t.return}function Nl(e){return e.tag===5||e.tag===3||e.tag===27}function Pl(e){return e&&e.tag===7&&e.stateNode!==null}function Fl(e){var t=e.type,n=e.memoizedProps,r=e.stateNode;try{a:switch(t){case`button`:case`input`:case`select`:case`textarea`:n.autoFocus&&r.focus();break a;case`img`:n.src?r.src=n.src:n.srcSet&&(r.srcset=n.srcSet)}}catch(t){Z(e,e.return,t)}}function Il(e,t,n){try{var r=e.stateNode;ip(r,e.type,n,t),r[kt]=t}catch(t){Z(e,e.return,t)}}function Ll(e){return e.tag===5||e.tag===3||e.tag===26||e.tag===27&&Sp(e.type)||e.tag===4}function Rl(e){a:for(;;){for(;e.sibling===null;){if(e.return===null||Ll(e.return))return null;e=e.return}for(e.sibling.return=e.return,e=e.sibling;e.tag!==5&&e.tag!==6&&e.tag!==18;){if(e.tag===27&&Sp(e.type)||e.flags&2||e.child===null||e.tag===4)continue a;e.child.return=e,e=e.child}if(!(e.flags&2))return e.stateNode}}function zl(e,t,n,r){var i=e.tag;if(i===5||i===6)i=e.stateNode,t?(n.nodeType===9?n.body:n.nodeName===`HTML`?n.ownerDocument.body:n).insertBefore(i,t):(t=n.nodeType===9?n.body:n.nodeName===`HTML`?n.ownerDocument.body:n,t.appendChild(i),n=n._reactRootContainer,n!=null||t.onclick!==null||(t.onclick=Sn)),Al(e,r),N=!0;else if(i!==4&&(i===27&&(Al(e,r),r=null,Sp(e.type)&&(n=e.stateNode,t=null)),e=e.child,e!==null))for(zl(e,t,n,r),e=e.sibling;e!==null;)zl(e,t,n,r),e=e.sibling}function Bl(e,t,n,r){var i=e.tag;if(i===5||i===6)i=e.stateNode,t?n.insertBefore(i,t):n.appendChild(i),Al(e,r),N=!0;else if(i!==4&&(i===27&&(Al(e,r),r=null,Sp(e.type)&&(n=e.stateNode)),e=e.child,e!==null))for(Bl(e,t,n,r),e=e.sibling;e!==null;)Bl(e,t,n,r),e=e.sibling}function Vl(e){var t=e.stateNode,n=e.memoizedProps;try{for(var r=e.type,i=t.attributes;i.length;)t.removeAttributeNode(i[0]);np(t,r,n),t[Ot]=e,t[kt]=n}catch(t){Z(e,e.return,t)}}var Hl=!1,Ul=null;function Wl(e){(e.tag===30||e.subtreeFlags&33554432)&&(Hl=!0)}var Gl=null;function Kl(){var e=Gl;return Gl=null,e}var ql=0;function Jl(e,t,n,r,i){return ql=0,Yl(e.child,t,n,r,i)}function Yl(e,t,n,r,i){for(var a=!1;e!==null;){if(e.tag===5){var o=e.stateNode;if(r!==null){var s=Op(o);r.push(s),s.view&&(a=!0)}else a||Op(o).view&&(a=!0);Hl=!0,Tp(o,ql===0?t:t+`_`+ql,n),ql++}else(e.tag!==22||e.memoizedState===null)&&(e.tag===30&&i||Yl(e.child,t,n,r,i)&&(a=!0));e=e.sibling}return a}function Xl(e,t){for(;e!==null;)e.tag===5?Ep(e.stateNode,e.memoizedProps):(e.tag!==22||e.memoizedState===null)&&(e.tag===30&&t||Xl(e.child,t)),e=e.sibling}function Zl(e){if(e.subtreeFlags&18874368)for(e=e.child;e!==null;){if((e.tag!==22||e.memoizedState===null)&&(Zl(e),e.tag===30&&e.flags&18874368&&e.stateNode.paired)){var t=e.memoizedProps;if(t.name==null||t.name===`auto`)throw Error(s(544));var n=t.name;t=Ci(t.default,t.share),t!==`none`&&(Jl(e,n,t,null,!1)||Xl(e.child,!1))}e=e.sibling}}function Ql(e,t){if(e.tag===30){var n=e.stateNode,r=e.memoizedProps,i=xi(r,n),a=Ci(r.default,n.paired?r.share:r.enter);a===`none`?Zl(e):Jl(e,i,a,null,!1)?(Zl(e),n.paired||t||Nd(e,r.onEnter)):Xl(e.child,!1)}else if(e.subtreeFlags&33554432)for(e=e.child;e!==null;)Ql(e,t),e=e.sibling;else Zl(e)}function $l(e){if(Ul!==null&&Ul.size!==0){var t=Ul;if(e.subtreeFlags&18874368)for(e=e.child;e!==null;){if(e.tag!==22||e.memoizedState===null){if(e.tag===30&&e.flags&18874368){var n=e.memoizedProps,r=n.name;if(r!=null&&r!==`auto`){var i=t.get(r);if(i!==void 0){var a=Ci(n.default,n.share);if(a!==`none`&&(Jl(e,r,a,null,!1)?(a=e.stateNode,i.paired=a,a.paired=i,Nd(e,n.onShare)):Xl(e.child,!1)),t.delete(r),t.size===0)break}}}$l(e)}e=e.sibling}}}function eu(e){if(e.tag===30){var t=e.memoizedProps,n=xi(t,e.stateNode),r=Ul===null?void 0:Ul.get(n),i=Ci(t.default,r===void 0?t.exit:t.share);i!==`none`&&(Jl(e,n,i,null,!1)?r===void 0?Nd(e,t.onExit):(i=e.stateNode,r.paired=i,i.paired=r,Ul.delete(n),Nd(e,t.onShare)):Xl(e.child,!1)),Ul!==null&&$l(e)}else if(e.subtreeFlags&33554432)for(e=e.child;e!==null;)eu(e),e=e.sibling;else Ul!==null&&$l(e)}function tu(e){for(e=e.child;e!==null;){if(e.tag===30){var t=e.memoizedProps,n=xi(t,e.stateNode);t=Ci(t.default,t.update),e.flags&=-5,t!==`none`&&Jl(e,n,t,e.memoizedState=[],!1)}else e.subtreeFlags&33554432&&tu(e);e=e.sibling}}function nu(e){if(e.subtreeFlags&18874368)for(e=e.child;e!==null;){if(e.tag!==22||e.memoizedState===null){if(e.tag===30&&e.flags&18874368){var t=e.stateNode;t.paired!==null&&(t.paired=null,Xl(e.child,!1))}nu(e)}e=e.sibling}}function ru(e){if(e.tag===30)e.stateNode.paired=null,Xl(e.child,!1),nu(e);else if(e.subtreeFlags&33554432)for(e=e.child;e!==null;)ru(e),e=e.sibling;else nu(e)}function iu(e){for(e=e.child;e!==null;)e.tag===30?Xl(e.child,!1):e.subtreeFlags&33554432&&iu(e),e=e.sibling}function au(e,t,n,r,i,a,o){for(var s=!1;t!==null;){if(t.tag===5){var c=t.stateNode;if(a!==null&&ql<a.length){var l=a[ql],u=Op(c);(l.view||u.view)&&(s=!0);var d;if(d=!(e.flags&4)){if(u.clip)d=!0;else{d=l.rect;var f=u.rect;d=d.y!==f.y||d.x!==f.x||d.height!==f.height||d.width!==f.width}}d&&(e.flags|=4),u.abs?u=!l.abs:(l=l.rect,u=u.rect,u=l.height!==u.height||l.width!==u.width),u&&(e.flags|=32)}else e.flags|=32;e.flags&4&&Tp(c,ql===0?n:n+`_`+ql,i),s&&e.flags&4||(Gl===null&&(Gl=[]),Gl.push(c,ql===0?r:r+`_`+ql,t.memoizedProps)),ql++}else(t.tag!==22||t.memoizedState===null)&&(t.tag===30&&o?e.flags|=t.flags&32:au(e,t.child,n,r,i,a,o)&&(s=!0));t=t.sibling}return s}function ou(e,t){for(e=e.child;e!==null;){if(e.tag===30){var n=e.memoizedProps,r=e.stateNode,i=xi(n,r),a=Ci(n.default,n.update);if(t){r=r.clones;var o=r===null?null:r.map(kp)}else o=e.memoizedState,e.memoizedState=null;r=e;var s=e.child;ql=0,i=au(r,s,i,i,a,o,!1),e.flags&4&&i&&(t||Nd(e,n.onUpdate))}else e.subtreeFlags&33554432&&ou(e,t);e=e.sibling}}var su=!1,H=!1,cu=!1,lu=!1,uu=typeof WeakSet==`function`?WeakSet:Set,du=null,fu=!1,pu=!1,mu=!1,hu=!1;function gu(e,t,n){if(e=e.containerInfo,sp=gh,e=Zr(e),Qr(e)){if(`selectionStart`in e)var r={start:e.selectionStart,end:e.selectionEnd};else a:{r=(r=e.ownerDocument)&&r.defaultView||window;var i=r.getSelection&&r.getSelection();if(i&&i.rangeCount!==0){r=i.anchorNode;var a=i.anchorOffset,o=i.focusNode;i=i.focusOffset;try{r.nodeType,o.nodeType}catch{r=null;break a}var s=0,c=-1,l=-1,u=0,d=0,f=e,p=null;b:for(;;){for(var m;f!==r||a!==0&&f.nodeType!==3||(c=s+a),f!==o||i!==0&&f.nodeType!==3||(l=s+i),f.nodeType===3&&(s+=f.nodeValue.length),(m=f.firstChild)!==null;)p=f,f=m;for(;;){if(f===e)break b;if(p===r&&++u===a&&(c=s),p===o&&++d===i&&(l=s),(m=f.nextSibling)!==null)break;f=p,p=f.parentNode}f=m}r=c===-1||l===-1?null:{start:c,end:l}}else r=null}r||={start:0,end:0}}else r=null;for(cp={focusedElem:e,selectionRange:r},gh=!1,n=(n&335544064)===n,du=t,t=n?9270:1024;du!==null;){if(e=du,n&&(r=e.deletions,r!==null))for(a=0;a<r.length;a++)n&&eu(r[a]);if(e.alternate===null&&e.flags&2)n&&Wl(e),_u(n);else{if(e.tag===22){if(r=e.alternate,e.memoizedState!==null){r!==null&&r.memoizedState===null&&n&&eu(r),_u(n);continue}if(r!==null&&r.memoizedState!==null){n&&Wl(e),_u(n);continue}}r=e.child,(e.subtreeFlags&t)!==0&&r!==null?(r.return=e,du=r):(n&&tu(e),_u(n))}}Ul=null}function _u(e){for(;du!==null;){var t=du,n=e,r=t.alternate,i=t.flags;switch(t.tag){case 0:case 11:case 15:break;case 1:if(i&1024&&r!==null){n=void 0,i=r.memoizedProps,r=r.memoizedState;var a=t.stateNode;try{var o=Tc(t.type,i);n=a.getSnapshotBeforeUpdate(o,r),a.__reactInternalSnapshotBeforeUpdate=n}catch(e){Z(t,t.return,e)}}break;case 3:if(i&1024){if(r=t.stateNode.containerInfo,n=r.nodeType,n===9)nm(r);else if(n===1)switch(r.nodeName){case`HEAD`:case`HTML`:case`BODY`:nm(r);break;default:r.textContent=``}}break;case 5:case 26:case 27:case 6:case 4:case 17:break;case 30:n&&r!==null&&(n=xi(r.memoizedProps,r.stateNode),i=t.memoizedProps,i=Ci(i.default,i.update),i!==`none`&&Jl(r,n,i,r.memoizedState=[],!0));break;default:if(i&1024)throw Error(s(163))}if(r=t.sibling,r!==null){r.return=t.return,du=r;break}du=t.return}}function vu(e,t,n){var r=n.flags;switch(n.tag){case 0:case 11:case 15:Lu(e,n),r&4&&wl(5,n);break;case 1:if(Lu(e,n),r&4){if(e=n.stateNode,t===null)try{e.componentDidMount()}catch(e){Z(n,n.return,e)}else{var i=Tc(n.type,t.memoizedProps);t=t.memoizedState;try{e.componentDidUpdate(i,t,e.__reactInternalSnapshotBeforeUpdate)}catch(e){Z(n,n.return,e)}}}r&64&&El(n),r&512&&Ol(n,n.return);break;case 3:if(Lu(e,n),r&64&&(e=n.updateQueue,e!==null)){if(t=null,n.child!==null)switch(n.child.tag){case 27:case 5:t=n.child.stateNode;break;case 1:t=n.child.stateNode}try{Oo(e,t)}catch(e){Z(n,n.return,e)}}break;case 27:t===null&&r&4&&Vl(n);case 26:case 5:Lu(e,n),t===null&&r&4&&Fl(n),r&512&&Ol(n,n.return);break;case 12:Lu(e,n);break;case 31:Lu(e,n),r&4&&Eu(e,n);break;case 13:Lu(e,n),r&4&&Du(e,n),r&64&&(e=n.memoizedState,e!==null&&(e=e.dehydrated,e!==null&&(n=_f.bind(null,n),cm(e,n))));break;case 22:if(r=n.memoizedState!==null||su,!r){var a=t!==null&&t.memoizedState!==null||H;t=su,i=H,su=r,(H=a)&&!i?(r=2,n.subtreeFlags&8772&&(r|=1),zu(e,n,r)):Lu(e,n),su=t,H=i}break;case 30:Lu(e,n),r&512&&Ol(n,n.return);break;case 7:r&512&&Ol(n,n.return);default:Lu(e,n)}}function yu(e,t){for(e=e.child;e!==null;)bu(e,t),e=e.sibling}function bu(e,t){switch(e.tag){case 5:case 26:try{var n=e.stateNode;if(t){var r=n.style;typeof r.setProperty==`function`?r.setProperty(`display`,`none`,`important`):r.display=`none`}else{var i=e.stateNode,a=e.memoizedProps.style,o=a!=null&&a.hasOwnProperty(`display`)?a.display:null;i.style.display=o==null||typeof o==`boolean`?``:(``+o).trim()}}catch(t){Z(e,e.return,t)}xu(e,t);break;case 6:try{e.stateNode.nodeValue=t?``:e.memoizedProps,N=!0}catch(t){Z(e,e.return,t)}break;case 18:try{var s=e.stateNode;t?wp(s,!0):wp(e.stateNode,!1)}catch(t){Z(e,e.return,t)}break;case 22:case 23:e.memoizedState===null&&yu(e,t);break;default:yu(e,t)}}function xu(e,t){if(e.subtreeFlags&67108864)for(e=e.child;e!==null;){a:{var n=e,r=t;switch(n.tag){case 4:bu(n,r);break a;case 22:n.memoizedState===null&&xu(n,r);break a;default:xu(n,r)}}e=e.sibling}}function Su(e){var t=e.alternate;t!==null&&(e.alternate=null,Su(t)),e.child=null,e.deletions=null,e.sibling=null,e.tag===5&&(t=e.stateNode,t!==null&&Lt(t)),e.stateNode=null,e.return=null,e.dependencies=null,e.memoizedProps=null,e.memoizedState=null,e.pendingProps=null,e.stateNode=null,e.updateQueue=null}var U=null,Cu=!1;function wu(e,t,n){for(n=n.child;n!==null;)Tu(e,t,n),n=n.sibling}function Tu(e,t,n){if(rt&&typeof rt.onCommitFiberUnmount==`function`)try{rt.onCommitFiberUnmount(nt,n)}catch{}switch(n.tag){case 26:H||kl(n,t),wu(e,t,n),n.memoizedState?n.memoizedState.count--:n.stateNode&&!H&&(n=n.stateNode,n.parentNode.removeChild(n));break;case 27:H||kl(n,t),Ml(n);var r=U,i=Cu;Sp(n.type)&&(U=n.stateNode,Cu=!1),wu(e,t,n),gm(n.stateNode,n.type,n.memoizedProps),U=r,Cu=i;break;case 5:H||kl(n,t),Ml(n);case 6:if(n.tag===6&&Ml(n),r=U,i=Cu,U=null,wu(e,t,n),U=r,Cu=i,U!==null){if(Cu)try{(U.nodeType===9?U.body:U.nodeName===`HTML`?U.ownerDocument.body:U).removeChild(n.stateNode),N=!0}catch(e){Z(n,t,e)}else try{U.removeChild(n.stateNode),N=!0}catch(e){Z(n,t,e)}}break;case 18:U!==null&&(Cu?(e=U,Cp(e.nodeType===9?e.body:e.nodeName===`HTML`?e.ownerDocument.body:e,n.stateNode),Hh(e)):Cp(U,n.stateNode));break;case 4:r=U,i=Cu,U=n.stateNode.containerInfo,Cu=!0,wu(e,t,n),U=r,Cu=i;break;case 0:case 11:case 14:case 15:Tl(2,n,t),H||Tl(4,n,t),wu(e,t,n);break;case 1:H||(kl(n,t),r=n.stateNode,typeof r.componentWillUnmount==`function`&&Dl(n,t,r)),wu(e,t,n);break;case 21:wu(e,t,n);break;case 22:H=(r=H)||n.memoizedState!==null,wu(e,t,n),H=r;break;case 30:kl(n,t),wu(e,t,n);break;case 7:H||kl(n,t),wu(e,t,n);break;default:wu(e,t,n)}}function Eu(e,t){if(t.memoizedState===null&&(e=t.alternate,e!==null&&(e=e.memoizedState,e!==null))){e=e.dehydrated;try{Hh(e)}catch(e){Z(t,t.return,e)}}}function Du(e,t){if(t.memoizedState===null&&(e=t.alternate,e!==null&&(e=e.memoizedState,e!==null&&(e=e.dehydrated,e!==null))))try{Hh(e)}catch(e){Z(t,t.return,e)}}function Ou(e){switch(e.tag){case 31:case 13:case 19:var t=e.stateNode;return t===null&&(t=e.stateNode=new uu),t;case 22:return e=e.stateNode,t=e._retryCache,t===null&&(t=e._retryCache=new uu),t;default:throw Error(s(435,e.tag))}}function ku(e,t){var n=Ou(e);t.forEach(function(t){if(!n.has(t)){n.add(t);var r=vf.bind(null,e,t);t.then(r,r)}})}function Au(e,t,n){var r=t.deletions;if(r!==null)for(var i=0;i<r.length;i++){var a=r[i],o=e,c=t,l=c;a:for(;l!==null;){switch(l.tag){case 27:if(Sp(l.type)){U=l.stateNode,Cu=!1;break a}break;case 5:U=l.stateNode,Cu=!1;break a;case 3:case 4:U=l.stateNode.containerInfo,Cu=!0;break a}l=l.return}if(U===null)throw Error(s(160));Tu(o,c,a),U=null,Cu=!1,o=a.alternate,o!==null&&(o.return=null),a.return=null}if(t.subtreeFlags&13886)for(t=t.child;t!==null;)Mu(t,e,n),t=t.sibling}var ju=null;function Mu(e,t,n){var r=e.alternate,i=e.flags;switch(e.tag){case 0:case 11:case 14:case 15:if(i&4&&(r=e.updateQueue,r=r===null?null:r.events,r!==null))for(var a=0;a<r.length;a++){var o=r[a];o.ref.impl=o.nextImpl}Au(t,e,n),Nu(e),i&4&&(Tl(3,e,e.return),wl(3,e),Tl(5,e,e.return));break;case 1:Au(t,e,n),Nu(e),i&512&&(H||r===null||kl(r,r.return)),i&64&&su&&(e=e.updateQueue,e!==null&&(t=e.callbacks,t!==null&&(n=e.shared.hiddenCallbacks,e.shared.hiddenCallbacks=n===null?t:n.concat(t))));break;case 26:if(a=ju,Au(t,e,n),Nu(e),i&512&&(H||r===null||kl(r,r.return)),i&4){if(i=r===null?null:r.memoizedState,n=e.memoizedState,r===null){if(n===null){if(e.stateNode===null){if(su)e.stateNode=fp(e.type,e.memoizedProps,t.containerInfo,e);else{a:{t=e.type,n=e.memoizedProps,i=a.ownerDocument||a;b:switch(t){case`title`:r=i.getElementsByTagName(`title`)[0],(!r||r[Ft]||r[Ot]||r.namespaceURI===`http://www.w3.org/2000/svg`||r.hasAttribute(`itemprop`))&&(r=i.createElement(t),i.head.insertBefore(r,i.querySelector(`head > title`))),np(r,t,n),r[Ot]=e,Ht(r),t=r;break a;case`link`:if(a=Gm(`link`,`href`,i).get(t+(n.href||``))){for(o=0;o<a.length;o++)if(r=a[o],r.getAttribute(`href`)===(n.href==null||n.href===``?null:n.href)&&r.getAttribute(`rel`)===(n.rel==null?null:n.rel)&&r.getAttribute(`title`)===(n.title==null?null:n.title)&&r.getAttribute(`crossorigin`)===(n.crossOrigin==null?null:n.crossOrigin)){a.splice(o,1);break b}}r=i.createElement(t),np(r,t,n),i.head.appendChild(r);break;case`meta`:if(a=Gm(`meta`,`content`,i).get(t+(n.content||``))){for(o=0;o<a.length;o++)if(r=a[o],r.getAttribute(`content`)===(n.content==null?null:``+n.content)&&r.getAttribute(`name`)===(n.name==null?null:n.name)&&r.getAttribute(`property`)===(n.property==null?null:n.property)&&r.getAttribute(`http-equiv`)===(n.httpEquiv==null?null:n.httpEquiv)&&r.getAttribute(`charset`)===(n.charSet==null?null:n.charSet)){a.splice(o,1);break b}}r=i.createElement(t),np(r,t,n),i.head.appendChild(r);break;default:throw Error(s(468,t))}r[Ot]=e,Ht(r),t=r}e.stateNode=t}}else su||Km(a,e.type,e.stateNode)}else e.stateNode=Bm(a,n,e.memoizedProps)}else i===n?n===null&&e.stateNode!==null&&Il(e,e.memoizedProps,r.memoizedProps):(i===null?(t=r.stateNode,t===null||H||t.parentNode.removeChild(t)):i.count--,n===null?su||Km(a,e.type,e.stateNode):Bm(a,n,e.memoizedProps))}break;case 27:Au(t,e,n),Nu(e),i&512&&(H||r===null||kl(r,r.return)),r!==null&&i&4&&Il(e,e.memoizedProps,r.memoizedProps);break;case 5:if(a=cu,cu=!1,Au(t,e,n),cu=a,Nu(e),i&512&&(H||r===null||kl(r,r.return)),e.flags&32){t=e.stateNode;try{hn(t,``),N=!0}catch(t){Z(e,e.return,t)}}i&4&&e.stateNode!=null&&(t=e.memoizedProps,Il(e,t,r===null?t:r.memoizedProps)),i&1024&&(lu=!0);break;case 6:if(Au(t,e,n),Nu(e),i&4){if(e.stateNode===null)throw Error(s(162));t=e.memoizedProps,n=e.stateNode;try{n.nodeValue=t,N=!0}catch(t){Z(e,e.return,t)}}break;case 3:if(N=!1,Wm=null,a=ju,ju=bm(t.containerInfo),Au(t,e,n),ju=a,Nu(e),i&4&&r!==null&&r.memoizedState.isDehydrated)try{Hh(t.containerInfo)}catch(t){Z(e,e.return,t)}lu&&(lu=!1,Pu(e)),N=!1;break;case 4:i=cu,cu=su,r=Qt(),a=ju,ju=bm(e.stateNode.containerInfo),Au(t,e,n),Nu(e),ju=a,N&&pu&&(mu=!0),N=r,cu=i;break;case 12:Au(t,e,n),Nu(e);break;case 31:Au(t,e,n),Nu(e),i&4&&(t=e.updateQueue,t!==null&&(e.updateQueue=null,ku(e,t)));break;case 13:Au(t,e,n),Nu(e),e.child.flags&8192&&e.memoizedState!==null!=(r!==null&&r.memoizedState!==null)&&(hd=qe()),i&4&&(t=e.updateQueue,t!==null&&(e.updateQueue=null,ku(e,t)));break;case 22:a=e.memoizedState!==null,o=r!==null&&r.memoizedState!==null;var c=su,l=H,u=cu;su=c||a,cu=u||a,H=l||o,Au(t,e,n),H=l,cu=u,su=c,Nu(e),i&8192&&(t=e.stateNode,t._visibility=a?t._visibility&-2:t._visibility|1,!a||r===null||o||su||H||(t=o||H,n=su,r=H,su=a||su,H=t,Ru(e,2),su=n,H=r),!a&&cu||yu(e,a)),i&4&&(t=e.updateQueue,t!==null&&(n=t.retryQueue,n!==null&&(t.retryQueue=null,ku(e,n))));break;case 19:Au(t,e,n),Nu(e),i&4&&(t=e.updateQueue,t!==null&&(e.updateQueue=null,ku(e,t)));break;case 30:i&512&&(H||r===null||kl(r,r.return)),i=Qt(),a=pu,o=(n&335544064)===n,c=e.memoizedProps,pu=o&&Ci(c.default,c.update)!==`none`,Au(t,e,n),Nu(e),o&&r!==null&&N&&(e.flags|=4),pu=a,N=i;break;case 21:break;case 7:i&512&&(H||r===null||kl(r,r.return)),r&&r.stateNode!==null&&(r.stateNode._fragmentFiber=e);default:Au(t,e,n),Nu(e)}}function Nu(e){var t=e.flags;if(t&2){try{for(var n,r=e.return;r!==null;){if(Ll(r)){n=r;break}r=r.return}r=null;for(var i=e.return;i!==null;){if(Pl(i)){var a=i.stateNode;r===null?r=[a]:r.push(a)}if(Nl(i))break;i=i.return}var o=r;if(n==null)throw Error(s(160));switch(n.tag){case 27:var c=n.stateNode;Bl(e,Rl(e),c,o);break;case 5:var l=n.stateNode;n.flags&32&&(hn(l,``),n.flags&=-33),Bl(e,Rl(e),l,o);break;case 3:case 4:var u=n.stateNode.containerInfo;zl(e,Rl(e),u,o);break;default:throw Error(s(161))}}catch(t){Z(e,e.return,t)}e.flags&=-3}t&4096&&(e.flags&=-4097)}function Pu(e){if(e.subtreeFlags&1024)for(e=e.child;e!==null;){var t=e;Pu(t),t.tag===5&&t.flags&1024&&(t=t.stateNode,gh=!0,t.reset(),gh=!1),e=e.sibling}}function Fu(e,t){if(t.subtreeFlags&9270)for(t=t.child;t!==null;)Iu(t,e),t=t.sibling;else ou(t,!1)}function Iu(e,t){var n=e.alternate;if(n===null)Ql(e,!1);else switch(e.tag){case 3:if(hu=fu=!1,Kl(),Fu(t,e),!fu&&!mu){if(e=Gl,e!==null)for(var r=0;r<e.length;r+=3){n=e[r];var i=e[r+1];Ep(n,e[r+2]),n=n.ownerDocument.documentElement,n!==null&&n.animate({opacity:[0,0],pointerEvents:[`none`,`none`]},{duration:0,fill:`forwards`,pseudoElement:`::view-transition-group(`+i+`)`})}e=t.containerInfo,e=e.nodeType===9?e.documentElement:e.ownerDocument.documentElement,e!==null&&e.style.viewTransitionName===``&&(e.style.viewTransitionName=`none`,e.animate({opacity:[0,0],pointerEvents:[`none`,`none`]},{duration:0,fill:`forwards`,pseudoElement:`::view-transition-group(root)`}),e.animate({width:[0,0],height:[0,0]},{duration:0,fill:`forwards`,pseudoElement:`::view-transition`})),hu=!0}Gl=null;break;case 5:Fu(t,e);break;case 4:r=fu,fu=!1,Fu(t,e),fu&&(mu=!0),fu=r;break;case 22:e.memoizedState===null&&(n.memoizedState===null?Fu(t,e):Ql(e,!1));break;case 30:r=fu,i=Kl(),fu=!1,Fu(t,e),fu&&(e.flags|=4);var a=e.memoizedProps,o=e.stateNode;t=xi(a,o),o=xi(n.memoizedProps,o);var s=Ci(a.default,a.update);s===`none`?t=!1:(a=n.memoizedState,n.memoizedState=null,n=e.child,ql=0,t=au(e,n,t,o,s,a,!0),ql!==(a===null?0:a.length)&&(e.flags|=32)),e.flags&4&&t?(Nd(e,e.memoizedProps.onUpdate),Gl=i):i!==null&&(i.push.apply(i,Gl),Gl=i),fu=e.flags&32?!0:r;break;default:Fu(t,e)}}function Lu(e,t){if(t.subtreeFlags&8772)for(t=t.child;t!==null;)vu(e,t.alternate,t),t=t.sibling}function Ru(e,t){for(e=e.child;e!==null;){var n=e,r=t;switch(n.tag){case 0:case 11:case 14:case 15:Tl(4,n,n.return),Ru(n,r);break;case 1:kl(n,n.return);var i=n.stateNode;typeof i.componentWillUnmount==`function`&&Dl(n,n.return,i),Ru(n,r);break;case 27:r&2&&gm(n.stateNode,n.type,n.memoizedProps);case 5:kl(n,n.return),n.tag!==5&&n.tag!==27||Ml(n),Ru(n,r);break;case 6:Ml(n);break;case 26:kl(n,n.return),i=n.stateNode,n.memoizedState!==null||i===null||H||i.parentNode.removeChild(i),Ru(n,r);break;case 22:n.memoizedState===null&&Ru(n,r);break;case 30:kl(n,n.return),Ru(n,r);break;case 7:kl(n,n.return);default:Ru(n,r)}e=e.sibling}}function zu(e,t,n){for(n=t.subtreeFlags&8772?n:n&-2,t=t.child;t!==null;){var r=t.alternate,i=e,a=t,o=a.flags,s=!!(n&1);switch(a.tag){case 0:case 11:case 15:zu(i,a,n),wl(4,a);break;case 1:if(zu(i,a,n),r=a,i=r.stateNode,typeof i.componentDidMount==`function`)try{i.componentDidMount()}catch(e){Z(r,r.return,e)}if(r=a,i=r.updateQueue,i!==null){var c=r.stateNode;try{var l=i.shared.hiddenCallbacks;if(l!==null)for(i.shared.hiddenCallbacks=null,i=0;i<l.length;i++)Do(l[i],c)}catch(e){Z(r,r.return,e)}}s&&o&64&&El(a),Ol(a,a.return);break;case 27:n&2&&Vl(a);case 5:a.tag!==5&&a.tag!==27||jl(a),zu(i,a,n),s&&r===null&&o&4&&Fl(a),Ol(a,a.return);break;case 6:jl(a);break;case 26:c=a.stateNode,a.memoizedState!==null||c===null||su||Km(bm(c.ownerDocument),a.type,c),zu(i,a,n),s&&r===null&&o&4&&Fl(a),Ol(a,a.return);break;case 12:zu(i,a,n);break;case 31:zu(i,a,n),s&&o&4&&Eu(i,a);break;case 13:zu(i,a,n),s&&o&4&&Du(i,a);break;case 22:a.memoizedState===null&&zu(i,a,n),Ol(a,a.return);break;case 30:zu(i,a,n),Ol(a,a.return);break;case 7:Ol(a,a.return);default:zu(i,a,n)}t=t.sibling}}function Bu(e,t){var n=null;e!==null&&e.memoizedState!==null&&e.memoizedState.cachePool!==null&&(n=e.memoizedState.cachePool.pool),e=null,t.memoizedState!==null&&t.memoizedState.cachePool!==null&&(e=t.memoizedState.cachePool.pool),e!==n&&(e!=null&&e.refCount++,n!=null&&Ia(n))}function Vu(e,t){e=null,t.alternate!==null&&(e=t.alternate.memoizedState.cache),t=t.memoizedState.cache,t!==e&&(t.refCount++,e!=null&&Ia(e))}function Hu(e,t,n,r){var i=(n&335544064)===n;if(t.subtreeFlags&(i?10262:10256))for(t=t.child;t!==null;)Uu(e,t,n,r),t=t.sibling;else i&&iu(t)}function Uu(e,t,n,r){var i=(n&335544064)===n;i&&t.alternate===null&&t.return!==null&&t.return.alternate!==null&&ru(t);var a=t.flags;switch(t.tag){case 0:case 11:case 15:Hu(e,t,n,r),a&2048&&wl(9,t);break;case 1:Hu(e,t,n,r);break;case 3:Hu(e,t,n,r),i&&hu&&(e=e.containerInfo,e=e.nodeType===9?e.body:e.nodeName===`HTML`?e.ownerDocument.body:e,e.style.viewTransitionName===`root`&&(e.style.viewTransitionName=``),e=e.ownerDocument.documentElement,e!==null&&e.style.viewTransitionName===`none`&&(e.style.viewTransitionName=``)),a&2048&&(a=null,t.alternate!==null&&(a=t.alternate.memoizedState.cache),t=t.memoizedState.cache,t!==a&&(t.refCount++,a!=null&&Ia(a)));break;case 12:if(a&2048){Hu(e,t,n,r),a=t.stateNode;try{var o=t.memoizedProps,s=o.id,c=o.onPostCommit;typeof c==`function`&&c(s,t.alternate===null?`mount`:`update`,a.passiveEffectDuration,-0)}catch(e){Z(t,t.return,e)}}else Hu(e,t,n,r);break;case 31:Hu(e,t,n,r);break;case 13:Hu(e,t,n,r);break;case 23:break;case 22:o=t.stateNode,s=t.alternate,t.memoizedState===null?(i&&s!==null&&s.memoizedState!==null&&ru(t),o._visibility&2?Hu(e,t,n,r):(o._visibility|=2,Wu(e,t,n,r,!!(t.subtreeFlags&10256)||!1))):(i&&s!==null&&s.memoizedState===null&&ru(s),o._visibility&2?Hu(e,t,n,r):Gu(e,t)),a&2048&&Bu(s,t);break;case 24:Hu(e,t,n,r),a&2048&&Vu(t.alternate,t);break;case 30:i&&(a=t.alternate,a!==null&&(Xl(a.child,!0),Xl(t.child,!0))),Hu(e,t,n,r);break;default:Hu(e,t,n,r)}}function Wu(e,t,n,r,i){for(i&&=!!(t.subtreeFlags&10256)||!1,t=t.child;t!==null;){var a=e,o=t,s=n,c=r,l=o.flags;switch(o.tag){case 0:case 11:case 15:Wu(a,o,s,c,i),wl(8,o);break;case 23:break;case 22:var u=o.stateNode;o.memoizedState===null?(u._visibility|=2,Wu(a,o,s,c,i)):u._visibility&2?Wu(a,o,s,c,i):Gu(a,o),i&&l&2048&&Bu(o.alternate,o);break;case 24:Wu(a,o,s,c,i),i&&l&2048&&Vu(o.alternate,o);break;default:Wu(a,o,s,c,i)}t=t.sibling}}function Gu(e,t){if(t.subtreeFlags&10256)for(t=t.child;t!==null;){var n=e,r=t,i=r.flags;switch(r.tag){case 22:Gu(n,r),i&2048&&Bu(r.alternate,r);break;case 24:Gu(n,r),i&2048&&Vu(r.alternate,r);break;default:Gu(n,r)}t=t.sibling}}var Ku=8192;function qu(e,t,n){if(e.subtreeFlags&Ku)for(e=e.child;e!==null;)Ju(e,t,n),e=e.sibling}function Ju(e,t,n){switch(e.tag){case 26:qu(e,t,n),e.flags&Ku&&(e.memoizedState===null?(e=e.stateNode,(t&335544128)===t&&Zm(n,e)):Qm(n,ju,e.memoizedState,e.memoizedProps));break;case 5:qu(e,t,n),e.flags&Ku&&(e=e.stateNode,(t&335544128)===t&&Zm(n,e));break;case 3:case 4:var r=ju;ju=bm(e.stateNode.containerInfo),qu(e,t,n),ju=r;break;case 22:e.memoizedState===null&&(r=e.alternate,r!==null&&r.memoizedState!==null?(r=Ku,Ku=16777216,qu(e,t,n),Ku=r):qu(e,t,n));break;case 30:if((e.flags&Ku)!==0&&(r=e.memoizedProps.name,r!=null&&r!==`auto`)){var i=e.stateNode;i.paired=null,Ul===null&&(Ul=new Map),Ul.set(r,i)}qu(e,t,n);break;default:qu(e,t,n)}}function Yu(e){var t=e.alternate;if(t!==null&&(e=t.child,e!==null)){t.child=null;do t=e.sibling,e.sibling=null,e=t;while(e!==null)}}function Xu(e){var t=e.deletions;if(e.flags&16){if(t!==null)for(var n=0;n<t.length;n++){var r=t[n];du=r,$u(r,e)}Yu(e)}if(e.subtreeFlags&10256)for(e=e.child;e!==null;)Zu(e),e=e.sibling}function Zu(e){switch(e.tag){case 0:case 11:case 15:Xu(e),e.flags&2048&&Tl(9,e,e.return);break;case 3:Xu(e);break;case 12:Xu(e);break;case 22:var t=e.stateNode;e.memoizedState!==null&&t._visibility&2&&(e.return===null||e.return.tag!==13)?(t._visibility&=-3,Qu(e)):Xu(e);break;default:Xu(e)}}function Qu(e){var t=e.deletions;if(e.flags&16){if(t!==null)for(var n=0;n<t.length;n++){var r=t[n];du=r,$u(r,e)}Yu(e)}for(e=e.child;e!==null;){switch(t=e,t.tag){case 0:case 11:case 15:Tl(8,t,t.return),Qu(t);break;case 22:n=t.stateNode,n._visibility&2&&(n._visibility&=-3,Qu(t));break;default:Qu(t)}e=e.sibling}}function $u(e,t){for(;du!==null;){var n=du;switch(n.tag){case 0:case 11:case 15:Tl(8,n,t);break;case 23:case 22:if(n.memoizedState!==null&&n.memoizedState.cachePool!==null){var r=n.memoizedState.cachePool.pool;r!=null&&r.refCount++}break;case 24:Ia(n.memoizedState.cache)}if(r=n.child,r!==null)r.return=n,du=r;else a:for(n=e;du!==null;){r=du;var i=r.sibling,a=r.return;if(Su(r),r===n){du=null;break a}if(i!==null){i.return=a,du=i;break a}du=a}}}var ed={getCacheForType:function(e){var t=Oa(Pa),n=t.data.get(e);return n===void 0&&(n=e(),t.data.set(e,n)),n},cacheSignal:function(){return Oa(Pa).controller.signal}},td=typeof WeakMap==`function`?WeakMap:Map,W=0,G=null,K=null,q=0,J=0,nd=null,rd=!1,id=!1,ad=!1,od=0,Y=0,sd=0,cd=0,ld=0,ud=0,dd=0,fd=null,pd=null,md=!1,hd=0,gd=0,_d=1/0,vd=null,yd=null,X=0,bd=null,xd=null,Sd=0,Cd=0,wd=null,Td=null,Ed=null,Dd=null,Od=null,kd=0,Ad=null;function jd(){return W&2&&q!==0?q&-q:T.T===null?Tt():Pf()}function Md(){if(ud===0){if(!(q&536870912)||L){var e=lt;lt<<=1,!(lt&3932160)&&(lt=262144),ud=e}else ud=536870912}return e=Po.current,e!==null&&(e.flags|=32),ud}function Nd(e,t){if(t!=null){var n=e.stateNode,r=n.ref;r===null&&(r=n.ref=Pp(xi(e.memoizedProps,n))),Dd===null&&(Dd=[]),Dd.push(t.bind(null,r))}}function Pd(e,t,n){(e===G&&(J===2||J===9)||e.cancelPendingCommit!==null)&&(Vd(e,0),Rd(e,q,ud,!1)),vt(e,n),(!(W&2)||e!==G)&&(e===G&&(!(W&2)&&(cd|=n),Y===4&&Rd(e,q,ud,!1)),Ef(e))}function Fd(e,t,n){if(W&6)throw Error(s(327));var r=!n&&!(t&127)&&(t&e.expiredLanes)===0||pt(e,t),i=r?Yd(e,t):qd(e,t,!0),a=r;do{if(i===0){id&&!r&&Rd(e,t,0,!1);break}if(n=e.current.alternate,a&&!Ld(n))i=qd(e,t,!1),a=!1;else{if(i===2){if(a=t,e.errorRecoveryDisabledLanes&a)var o=0;else o=e.pendingLanes&-536870913,o=o===0?o&536870912?536870912:0:o;if(o!==0){t=o;a:{var c=e;i=fd;var l=c.current.memoizedState.isDehydrated;if(l&&(Vd(c,o).flags|=256),o=qd(c,o,!1),o!==2&&o!==6){if(ad&&!l){c.errorRecoveryDisabledLanes|=a,cd|=a,i=4;break a}a=pd,pd=i,a!==null&&(pd===null?pd=a:pd.push.apply(pd,a))}i=o}if(a=!1,i!==2)continue}}if(i===1){Vd(e,0),Rd(e,t,0,!0);break}a:{switch(r=e,a=i,a){case 0:case 1:throw Error(s(345));case 4:if((t&4194048)!==t&&(t&62914560)!==t)break;case 6:Rd(r,t,ud,!rd);break a;case 2:pd=null;break;case 3:case 5:break;default:throw Error(s(329))}if((t&62914560)===t&&(i=hd+300-qe(),10<i)){if(Rd(r,t,ud,!rd),ft(r,0,!0)!==0)break a;Sd=t,r.timeoutHandle=gp(Id.bind(null,r,n,pd,vd,md,t,ud,cd,dd,rd,a,`Throttled`,-0,0),i);break a}Id(r,n,pd,vd,md,t,ud,cd,dd,rd,a,null,-0,0)}break}}while(1);Ef(e)}function Id(e,t,n,r,i,a,o,s,c,l,u,d,f,p){e.timeoutHandle=-1;var m=t.subtreeFlags,h=(a&335544064)===a;d=null,(h||m&8192||(m&16785408)==16785408)&&(d={stylesheets:null,count:0,imgCount:0,imgBytes:0,suspenseyImages:[],waitingForImages:!0,waitingForViewTransition:!1,unsuspend:Sn},Ul=null,Ju(t,a,d),h&&(m=d,h=e.containerInfo,h=(h.nodeType===9?h:h.ownerDocument).__reactViewTransition,h!=null&&(m.count++,m.waitingForViewTransition=!0,m=nh.bind(m),h.finished.then(m,m))),m=(a&62914560)===a?hd-qe():(a&4194048)===a?gd-qe():0,m=eh(d,m),m!==null)?(Sd=a,e.cancelPendingCommit=m(nf.bind(null,e,t,a,n,r,i,o,s,c,l,u,d,null,f,p)),Rd(e,a,o,!l)):nf(e,t,a,n,r,i,o,s,c,l,u,d)}function Ld(e){for(var t=e;;){var n=t.tag;if((n===0||n===11||n===15)&&t.flags&16384&&(n=t.updateQueue,n!==null&&(n=n.stores,n!==null)))for(var r=0;r<n.length;r++){var i=n[r],a=i.getSnapshot;i=i.value;try{if(!Gr(a(),i))return!1}catch{return!1}}if(n=t.child,t.subtreeFlags&16384&&n!==null)n.return=t,t=n;else{if(t===e)break;for(;t.sibling===null;){if(t.return===null||t.return===e)return!0;t=t.return}t.sibling.return=t.return,t=t.sibling}}return!0}function Rd(e,t,n,r){t=mt(e,t),t&=~ld,t&=~cd,e.suspendedLanes|=t,e.pingedLanes&=~t,r&&(e.warmLanes|=t),r=e.expirationTimes;for(var i=t;0<i;){var a=31-at(i),o=1<<a;r[a]=-1,i&=~o}n!==0&&bt(e,n,t)}function zd(){return W&6?!0:(Df(0,!1),!1)}function Bd(){if(K!==null){if(J===0)var e=K.return;else e=K,ba=ya=null,ss(e),co=null,lo=0,e=K;for(;e!==null;)Cl(e.alternate,e),e=e.return;K=null}}function Vd(e,t){var n=e.timeoutHandle;return n!==-1&&(e.timeoutHandle=-1,_p(n)),n=e.cancelPendingCommit,n!==null&&(e.cancelPendingCommit=null,n()),Sd=0,Bd(),G=e,K=n=Ri(e.current,null),q=t,J=0,nd=null,rd=!1,id=pt(e,t),ad=!1,dd=ud=ld=cd=sd=Y=0,pd=fd=null,md=!1,od=mt(e,t),Oi(),n}function Hd(e,t){R=null,T.H=_c,t===Qa||t===eo?(t=oo(),J=3):t===$a?(t=oo(),J=4):J=t===Fc?8:typeof t==`object`&&t&&typeof t.then==`function`?6:1,nd=t,K===null&&(Y=1,kc(e,Ki(t,e.current)))}function Ud(){var e=Po.current;return e===null?!0:(q&4194048)===q?Fo===null:(q&62914560)===q||q&536870912?e===Fo:!1}function Wd(){var e=T.H;return T.H=_c,e===null?_c:e}function Gd(){var e=T.A;return T.A=ed,e}function Kd(){Y=4,rd||(q&4194048)!==q&&Po.current!==null||(id=!0),!(sd&134217727)&&!(cd&134217727)||G===null||Rd(G,q,ud,!1)}function qd(e,t,n){var r=W;W|=2;var i=Wd(),a=Gd();(G!==e||q!==t)&&(vd=null,Vd(e,t)),t=!1;var o=Y;a:do try{if(J!==0&&K!==null){var s=K,c=nd;switch(J){case 8:Bd(),o=6;break a;case 3:case 2:case 9:case 6:Po.current===null&&(t=!0);var l=J;if(J=0,nd=null,$d(e,s,c,l),n&&id){o=0;break a}break;default:l=J,J=0,nd=null,$d(e,s,c,l)}}Jd(),o=Y;break}catch(t){Hd(e,t)}while(1);return t&&e.shellSuspendCounter++,ba=ya=null,W=r,T.H=i,T.A=a,K===null&&(G=null,q=0,Oi()),o}function Jd(){for(;K!==null;)Zd(K)}function Yd(e,t){var n=W;W|=2;var r=Wd(),i=Gd();G!==e||q!==t?(vd=null,_d=qe()+500,Vd(e,t)):id=pt(e,t);a:do try{if(J!==0&&K!==null){t=K;var a=nd;b:switch(J){case 1:J=0,nd=null,$d(e,t,a,1);break;case 2:case 9:if(no(a)){J=0,nd=null,Qd(t);break}t=function(){J!==2&&J!==9||G!==e||(J=7),Ef(e)},a.then(t,t);break a;case 3:J=7;break a;case 4:J=5;break a;case 7:no(a)?(J=0,nd=null,Qd(t)):(J=0,nd=null,$d(e,t,a,7));break;case 5:var o=null;switch(K.tag){case 26:o=K.memoizedState;case 5:case 27:var c=K;if(o?Ym(o):c.stateNode.complete){J=0,nd=null;var l=c.sibling;if(l!==null)K=l;else{var u=c.return;u===null?K=null:(K=u,ef(u))}break b}}J=0,nd=null,$d(e,t,a,5);break;case 6:J=0,nd=null,$d(e,t,a,6);break;case 8:Bd(),Y=6;break a;default:throw Error(s(462))}}Xd();break}catch(t){Hd(e,t)}while(1);return ba=ya=null,T.H=r,T.A=i,W=n,K===null?(G=null,q=0,Oi(),Y):0}function Xd(){for(;K!==null&&!Ge();)Zd(K)}function Zd(e){var t=hl(e.alternate,e,od);e.memoizedProps=e.pendingProps,t===null?ef(e):K=t}function Qd(e){var t=e,n=t.alternate;switch(t.tag){case 15:case 0:t=Yc(n,t,t.pendingProps,t.type,void 0,q);break;case 11:t=Yc(n,t,t.pendingProps,t.type.render,t.ref,q);break;case 5:ss(t);var r=t;r===sa&&(L?(pa(r),r.tag===5&&r.stateNode!=null&&(I=r.stateNode)):(pa(r),L=!0));default:Cl(n,t),t=K=zi(t,od),t=hl(n,t,od)}e.memoizedProps=e.pendingProps,t===null?ef(e):K=t}function $d(e,t,n,r){ba=ya=null,ss(t),co=null,lo=0;var i=t.return;try{if(Pc(e,i,t,n,q)){Y=1,kc(e,Ki(n,e.current)),K=null;return}}catch(t){if(i!==null)throw K=i,t;Y=1,kc(e,Ki(n,e.current)),K=null;return}t.flags&32768?(L||r===1?e=!0:id||q&536870912?e=!1:(rd=e=!0,(r===2||r===9||r===3||r===6)&&(r=Po.current,r!==null&&r.tag===13&&(r.flags|=16384))),tf(t,e)):ef(t)}function ef(e){var t=e;do{if(t.flags&32768){tf(t,rd);return}e=t.return;var n=xl(t.alternate,t,od);if(n!==null){K=n;return}if(t=t.sibling,t!==null){K=t;return}K=t=e}while(t!==null);Y===0&&(Y=5)}function tf(e,t){do{var n=Sl(e.alternate,e);if(n!==null){n.flags&=32767,K=n;return}if(n=e.return,n!==null&&(n.flags|=32768,n.subtreeFlags=0,n.deletions=null),!t&&(e=e.sibling,e!==null)){K=e;return}K=e=n}while(e!==null);Y=6,K=null}function nf(e,t,n,r,i,a,o,c,l,u,d,f){e.cancelPendingCommit=null;do df();while(X!==0);if(W&6)throw Error(s(327));if(t!==null){if(t===e.current)throw Error(s(177));e===G&&(K=G=null,q=0),xd=t,bd=e,Sd=n,wd=i,Td=r,rf(e,t,n,o,c,l,f)}}function rf(e,t,n,r,i,a,o){var s=t.lanes|t.childLanes;if(Cd=s,s|=Di,yt(e,n,s,r,i,a),Dd=null,(n&335544064)===n?(Od=za(e),r=10262):(Od=null,r=10256),(t.subtreeFlags&r)!==0||(t.flags&r)!==0?(e.callbackNode=null,e.callbackPriority=0,yf(Ze,function(){return ff(),null})):(e.callbackNode=null,e.callbackPriority=0),Hl=!1,r=!!(t.flags&13878),t.subtreeFlags&13878||r){r=T.T,T.T=null,i=E.p,E.p=2,a=W,W|=4;try{gu(e,t,n)}finally{W=a,E.p=i,T.T=r}}X=1,Hl?Ed=Mp(o,e.containerInfo,Od,sf,cf,of,lf,ff,af,null,null):(sf(),cf(),lf())}function af(e){if(X!==0){var t=bd.onRecoverableError;t(e,{componentStack:null})}}function of(){X===3&&(X=0,Iu(xd,bd),X=4)}function sf(){if(X===1){X=0;var e=bd,t=xd,n=Sd,r=!!(t.flags&13878);if(t.subtreeFlags&13878||r){r=T.T,T.T=null;var i=E.p;E.p=2;var a=W;W|=4;try{pu=mu=!1,Mu(t,e,n),n=cp;var o=Zr(e.containerInfo),s=n.focusedElem,c=n.selectionRange;if(o!==s&&s&&s.ownerDocument&&Xr(s.ownerDocument.documentElement,s)){if(c!==null&&Qr(s)){var l=c.start,u=c.end;if(u===void 0&&(u=l),`selectionStart`in s)s.selectionStart=l,s.selectionEnd=Math.min(u,s.value.length);else{var d=s.ownerDocument||document,f=d&&d.defaultView||window;if(f.getSelection){var p=f.getSelection(),m=s.textContent.length,h=Math.min(c.start,m),g=c.end===void 0?h:Math.min(c.end,m);!p.extend&&h>g&&(o=g,g=h,h=o);var _=Yr(s,h),v=Yr(s,g);if(_&&v&&(p.rangeCount!==1||p.anchorNode!==_.node||p.anchorOffset!==_.offset||p.focusNode!==v.node||p.focusOffset!==v.offset)){var y=d.createRange();y.setStart(_.node,_.offset),p.removeAllRanges(),h>g?(p.addRange(y),p.extend(v.node,v.offset)):(y.setEnd(v.node,v.offset),p.addRange(y))}}}}for(d=[],p=s;p=p.parentNode;)p.nodeType===1&&d.push({element:p,left:p.scrollLeft,top:p.scrollTop});for(typeof s.focus==`function`&&s.focus(),s=0;s<d.length;s++){var b=d[s];b.element.scrollLeft=b.left,b.element.scrollTop=b.top}}gh=!!sp,cp=sp=null}finally{W=a,E.p=i,T.T=r}}e.current=t,X=2}}function cf(){if(X===2){X=0;var e=bd,t=xd,n=!!(t.flags&8772);if(t.subtreeFlags&8772||n){n=T.T,T.T=null;var r=E.p;E.p=2;var i=W;W|=4;try{vu(e,t.alternate,t)}finally{W=i,E.p=r,T.T=n}}X=3}}function lf(){if(X===4||X===3){X=0;var e=Ed;Ed=null,Ke();var t=bd,n=xd,r=Sd,i=Td,a=(r&335544064)===r?10262:10256;if((n.subtreeFlags&a)!==0||(n.flags&a)!==0?X=5:(X=0,xd=bd=null,uf(t,t.pendingLanes)),a=t.pendingLanes,a===0&&(yd=null),wt(r),n=n.stateNode,rt&&typeof rt.onCommitFiberRoot==`function`)try{rt.onCommitFiberRoot(nt,n,void 0,(n.current.flags&128)==128)}catch{}if(i!==null){n=T.T,a=E.p,E.p=2,T.T=null;try{for(var o=t.onRecoverableError,s=0;s<i.length;s++){var c=i[s];o(c.value,{componentStack:c.stack})}}finally{T.T=n,E.p=a}}if(i=Dd,o=Od,Od=null,i!==null&&(Dd=null,o===null&&(o=[]),e!==null))for(c=0;c<i.length;c++)n=(0,i[c])(o),n!==void 0&&e.finished.finally(n);Sd&3&&df(),Ef(t),a=t.pendingLanes,r&261930&&a&42?t===Ad?kd++:(kd=0,Ad=t):(kd=0,Ad=null),Df(0,!1)}}function uf(e,t){(e.pooledCacheLanes&=t)===0&&(t=e.pooledCache,t!=null&&(e.pooledCache=null,Ia(t)))}function df(){return Ed!==null&&(Ed.skipTransition(),Ed=null),sf(),cf(),lf(),ff()}function ff(){if(X!==5)return!1;var e=bd,t=Cd;Cd=0;var n=wt(Sd),r=T.T,i=E.p;try{E.p=32>n?32:n,T.T=null,n=wd,wd=null;var a=bd,o=Sd;if(X=0,xd=bd=null,Sd=0,W&6)throw Error(s(331));var c=W;if(W|=4,Zu(a.current),Uu(a,a.current,o,n),W=c,Df(0,!1),rt&&typeof rt.onPostCommitFiberRoot==`function`)try{rt.onPostCommitFiberRoot(nt,a)}catch{}return!0}finally{E.p=i,T.T=r,uf(e,t)}}function pf(e,t,n){t=Ki(n,t),t=jc(e.stateNode,t,2),e=xo(e,t,2),e!==null&&(vt(e,2),Ef(e))}function Z(e,t,n){if(e.tag===3)pf(e,e,n);else for(;t!==null;){if(t.tag===3){pf(t,e,n);break}if(t.tag===1){var r=t.stateNode;if(typeof t.type.getDerivedStateFromError==`function`||typeof r.componentDidCatch==`function`&&(yd===null||!yd.has(r))){e=Ki(n,e),n=Mc(2),r=xo(t,n,2),r!==null&&(Nc(n,r,t,e),vt(r,2),Ef(r));break}}t=t.return}}function mf(e,t,n){var r=e.pingCache;if(r===null){r=e.pingCache=new td;var i=new Set;r.set(t,i)}else i=r.get(t),i===void 0&&(i=new Set,r.set(t,i));i.has(n)||(ad=!0,i.add(n),e=hf.bind(null,e,t,n),t.then(e,e))}function hf(e,t,n){var r=e.pingCache;r!==null&&r.delete(t),e.pingedLanes|=e.suspendedLanes&n,e.warmLanes&=~n,G===e&&(q&n)===n&&(Y===4||Y===3&&(q&62914560)===q&&300>qe()-hd?W&2?ld|=n:Vd(e,0):ld|=n,dd===q&&(dd=0)),Ef(e)}function gf(e,t){t===0&&(t=gt()),e=ji(e,t),e!==null&&(vt(e,t),Ef(e))}function _f(e){var t=e.memoizedState,n=0;t!==null&&(n=t.retryLane),gf(e,n)}function vf(e,t){var n=0;switch(e.tag){case 31:case 13:var r=e.stateNode,i=e.memoizedState;i!==null&&(n=i.retryLane);break;case 19:r=e.stateNode;break;case 22:r=e.stateNode._retryCache;break;default:throw Error(s(314))}r!==null&&r.delete(t),gf(e,n)}function yf(e,t){return We(e,t)}var bf=null,xf=null,Sf=!1,Cf=!1,wf=!1,Tf=0;function Ef(e){e!==xf&&e.next===null&&(xf===null?bf=xf=e:xf=xf.next=e),Cf=!0,Sf||(Sf=!0,Nf())}function Df(e,t){if(!wf&&Cf){wf=!0;do for(var n=!1,r=bf;r!==null;){if(!t){if(e!==0){var i=r.pendingLanes;if(i===0)var a=0;else{var o=r.suspendedLanes,s=r.pingedLanes;a=(1<<31-at(42|e)+1)-1,a&=i&~(o&~s),a=a&201326741?a&201326741|1:a?a|2:0}a!==0&&(n=!0,Mf(r,a))}else a=q,a=ft(r,r===G?a:0,r.cancelPendingCommit!==null||r.timeoutHandle!==-1),!(a&3)||pt(r,a)||(n=!0,Mf(r,a))}r=r.next}while(n);wf=!1}}function Of(){kf()}function kf(){Cf=Sf=!1;var e=0;Tf!==0&&hp()&&(e=Tf);for(var t=qe(),n=null,r=bf;r!==null;){var i=r.next,a=Af(r,t);a===0?(r.next=null,n===null?bf=i:n.next=i,i===null&&(xf=n)):(n=r,(e!==0||a&3)&&(Cf=!0)),r=i}X!==0&&X!==5||Df(e,!1),Tf!==0&&(Tf=0)}function Af(e,t){for(var n=e.suspendedLanes,r=e.pingedLanes,i=e.expirationTimes,a=e.pendingLanes&-62914561;0<a;){var o=31-at(a),s=1<<o,c=i[o];c===-1?((s&n)===0||(s&r)!==0)&&(i[o]=ht(s,t)):c<=t&&(e.expiredLanes|=s),a&=~s}if(t=G,n=q,n=ft(e,e===t?n:0,e.cancelPendingCommit!==null||e.timeoutHandle!==-1),r=e.callbackNode,n===0||e===t&&(J===2||J===9)||e.cancelPendingCommit!==null)return r!==null&&r!==null&&j(r),e.callbackNode=null,e.callbackPriority=0;if(!(n&3)||pt(e,n)){if(t=n&-n,t===e.callbackPriority)return t;switch(r!==null&&j(r),wt(n)){case 2:case 8:n=Xe;break;case 32:n=Ze;break;case 268435456:n=$e;break;default:n=Ze}return r=jf.bind(null,e),n=We(n,r),e.callbackPriority=t,e.callbackNode=n,t}return r!==null&&r!==null&&j(r),e.callbackPriority=2,e.callbackNode=null,2}function jf(e,t){if(X!==0&&X!==5)return e.callbackNode=null,e.callbackPriority=0,null;var n=e.callbackNode;if(df()&&e.callbackNode!==n)return null;var r=q;return r=ft(e,e===G?r:0,e.cancelPendingCommit!==null||e.timeoutHandle!==-1),r===0?null:(Fd(e,r,t),Af(e,qe()),e.callbackNode!=null&&e.callbackNode===n?jf.bind(null,e):null)}function Mf(e,t){if(df())return null;Fd(e,t,!0)}function Nf(){bp(function(){W&6?We(Ye,Of):kf()})}function Pf(){if(Tf===0){var e=Ha;e===0&&(e=M,M<<=1,!(M&261888)&&(M=256)),Tf=e}return Tf}function Ff(e){return e==null||typeof e==`symbol`||typeof e==`boolean`?null:typeof e==`function`?e:xn(e)}function If(e,t,n,r,i){if(t===`submit`&&n&&n.stateNode===i){var a=Ff((i[kt]||null).action),o=r.submitter;o&&(t=(t=o[kt]||null)?Ff(t.formAction):o.getAttribute(`formAction`),t!==null&&(a=t,o=null));var s=new Un(`action`,`action`,null,r,i);e.push({event:s,listeners:[{instance:null,listener:function(){if(r.defaultPrevented){if(Tf!==0){var e=new FormData(i,o);rc(n,{pending:!0,data:e,method:i.method,action:a},null,e)}}else typeof a==`function`&&(s.preventDefault(),e=new FormData(i,o),rc(n,{pending:!0,data:e,method:i.method,action:a},a,e))},currentTarget:i}]})}}for(var Lf=0;Lf<vi.length;Lf++){var Rf=vi[Lf];yi(Rf.toLowerCase(),`on`+(Rf[0].toUpperCase()+Rf.slice(1)))}yi(ui,`onAnimationEnd`),yi(di,`onAnimationIteration`),yi(fi,`onAnimationStart`),yi(`dblclick`,`onDoubleClick`),yi(`focusin`,`onFocus`),yi(`focusout`,`onBlur`),yi(pi,`onTransitionRun`),yi(mi,`onTransitionStart`),yi(hi,`onTransitionCancel`),yi(gi,`onTransitionEnd`),qt(`onMouseEnter`,[`mouseout`,`mouseover`]),qt(`onMouseLeave`,[`mouseout`,`mouseover`]),qt(`onPointerEnter`,[`pointerout`,`pointerover`]),qt(`onPointerLeave`,[`pointerout`,`pointerover`]),Kt(`onChange`,`change click focusin focusout input keydown keyup selectionchange`.split(` `)),Kt(`onSelect`,`focusout contextmenu dragend focusin keydown keyup mousedown mouseup selectionchange`.split(` `)),Kt(`onBeforeInput`,[`compositionend`,`keypress`,`textInput`,`paste`]),Kt(`onCompositionEnd`,`compositionend focusout keydown keypress keyup mousedown`.split(` `)),Kt(`onCompositionStart`,`compositionstart focusout keydown keypress keyup mousedown`.split(` `)),Kt(`onCompositionUpdate`,`compositionupdate focusout keydown keypress keyup mousedown`.split(` `));var zf=`abort canplay canplaythrough durationchange emptied encrypted ended error loadeddata loadedmetadata loadstart pause play playing progress ratechange resize seeked seeking stalled suspend timeupdate volumechange waiting`.split(` `),Bf=new Set(`beforetoggle cancel close invalid load scroll scrollend toggle`.split(` `).concat(zf));function Vf(e,t){t=!!(t&4);for(var n=0;n<e.length;n++){var r=e[n],i=r.event;r=r.listeners;a:{var a=void 0;if(t)for(var o=r.length-1;0<=o;o--){var s=r[o],c=s.instance,l=s.currentTarget;if(s=s.listener,c!==a&&i.isPropagationStopped())break a;a=s,i.currentTarget=l;try{a(i)}catch(e){wi(e)}i.currentTarget=null,a=c}else for(o=0;o<r.length;o++){if(s=r[o],c=s.instance,l=s.currentTarget,s=s.listener,c!==a&&i.isPropagationStopped())break a;a=s,i.currentTarget=l;try{a(i)}catch(e){wi(e)}i.currentTarget=null,a=c}}}}function Q(e,t){var n=t[jt];n===void 0&&(n=t[jt]=new Set);var r=e+`__bubble`;n.has(r)||(Gf(t,e,2,!1),n.add(r))}function Hf(e,t,n){var r=0;t&&(r|=4),Gf(n,e,r,t)}var Uf=`_reactListening`+Math.random().toString(36).slice(2);function Wf(e){if(!e[Uf]){e[Uf]=!0,Wt.forEach(function(t){t!==`selectionchange`&&(Bf.has(t)||Hf(t,!1,e),Hf(t,!0,e))});var t=e.nodeType===9?e:e.ownerDocument;t===null||t[Uf]||(t[Uf]=!0,Hf(`selectionchange`,!1,t))}}function Gf(e,t,n,r){switch(Ch(t)){case 2:var i=_h;break;case 8:i=vh;break;default:i=yh}n=i.bind(null,t,n,e),i=void 0,!Mn||t!==`touchstart`&&t!==`touchmove`&&t!==`wheel`||(i=!0),r?i===void 0?e.addEventListener(t,n,!0):e.addEventListener(t,n,{capture:!0,passive:i}):i===void 0?e.addEventListener(t,n,!1):e.addEventListener(t,n,{passive:i})}function Kf(e,t,n,r,i){var a=r;if(!(t&1)&&!(t&2)&&r!==null)a:for(;;){if(r===null)return;var o=r.tag;if(o===3||o===4){var s=r.stateNode.containerInfo;if(s===i)break;if(o===4)for(o=r.return;o!==null;){var c=o.tag;if((c===3||c===4)&&o.stateNode.containerInfo===i)return;o=o.return}for(;s!==null;){if(o=Rt(s),o===null)return;if(c=o.tag,c===5||c===6||c===26||c===27){r=a=o;continue a}s=s.parentNode}}r=r.return}kn(function(){var r=a,i=wn(n),o=[];a:{var s=_i.get(e);if(s!==void 0){var c=Un,u=e;switch(e){case`keypress`:if(Rn(n)===0)break a;case`keydown`:case`keyup`:c=sr;break;case`focusin`:u=`focus`,c=Qn;break;case`focusout`:u=`blur`,c=Qn;break;case`beforeblur`:case`afterblur`:c=Qn;break;case`click`:if(n.button===2)break a;case`auxclick`:case`dblclick`:case`mousedown`:case`mousemove`:case`mouseup`:case`mouseout`:case`mouseover`:case`contextmenu`:c=Xn;break;case`drag`:case`dragend`:case`dragenter`:case`dragexit`:case`dragleave`:case`dragover`:case`dragstart`:case`drop`:c=Zn;break;case`touchcancel`:case`touchend`:case`touchmove`:case`touchstart`:c=ur;break;case ui:case di:case fi:c=$n;break;case gi:c=dr;break;case`scroll`:case`scrollend`:c=Gn;break;case`wheel`:c=fr;break;case`copy`:case`cut`:case`paste`:c=er;break;case`gotpointercapture`:case`lostpointercapture`:case`pointercancel`:case`pointerdown`:case`pointermove`:case`pointerout`:case`pointerover`:case`pointerup`:c=cr;break;case`submit`:c=lr;break;case`toggle`:case`beforetoggle`:c=pr}var d=!!(t&4),f=!d&&(e===`scroll`||e===`scrollend`),p=d?s===null?null:s+`Capture`:s;d=[];for(var m=r,h;m!==null;){var g=m;if(h=g.stateNode,g=g.tag,g!==5&&g!==26&&g!==27||h===null||p===null||(g=An(m,p),g!=null&&d.push(qf(m,g,h))),f)break;m=m.return}0<d.length&&(s=new c(s,u,null,n,i),o.push({event:s,listeners:d}))}}if(!(t&7)){a:{if(c=e===`mouseover`||e===`pointerover`,s=e===`mouseout`||e===`pointerout`,c&&n!==Cn&&(u=n.relatedTarget||n.fromElement)&&(Rt(u)||u[At]))break a;(s||c)&&(u=i.window===i?i:(c=i.ownerDocument)?c.defaultView||c.parentWindow:window,s?(c=n.relatedTarget||n.toElement,s=r,c=c?Rt(c):null,c!==null&&(f=l(c),d=c.tag,c!==f||d!==5&&d!==27&&d!==6)&&(c=null)):(s=null,c=r),s!==c&&(d=Xn,g=`onMouseLeave`,p=`onMouseEnter`,m=`mouse`,(e===`pointerout`||e===`pointerover`)&&(d=cr,g=`onPointerLeave`,p=`onPointerEnter`,m=`pointer`),f=s==null?u:Bt(s),h=c==null?u:Bt(c),u=new d(g,m+`leave`,s,n,i),u.target=f,u.relatedTarget=h,g=null,Rt(i)===r&&(d=new d(p,m+`enter`,c,n,i),d.target=h,d.relatedTarget=f,g=d),f=g,d=s&&c?re(s,c,Yf):null,s!==null&&Xf(o,u,s,d,!1),c!==null&&f!==null&&Xf(o,f,c,d,!0)))}a:{if(s=r?Bt(r):window,c=s.nodeName&&s.nodeName.toLowerCase(),c===`select`||c===`input`&&s.type===`file`)var _=Nr;else if(Dr(s)){if(Pr)_=Ur;else{_=Vr;var v=Br}}else c=s.nodeName,!c||c.toLowerCase()!==`input`||s.type!==`checkbox`&&s.type!==`radio`?r&&vn(r.elementType)&&(_=Nr):_=Hr;if(_&&=_(e,r)){Or(o,_,n,i);break a}v&&v(e,s,r)}switch(v=r?Bt(r):window,e){case`focusin`:(Dr(v)||v.contentEditable===`true`)&&(ei=v,ti=r,ni=null);break;case`focusout`:ni=ti=ei=null;break;case`mousedown`:ri=!0;break;case`contextmenu`:case`mouseup`:case`dragend`:ri=!1,ii(o,n,i);break;case`selectionchange`:if($r)break;case`keydown`:case`keyup`:ii(o,n,i)}var y;if(hr)b:{switch(e){case`compositionstart`:var b=`onCompositionStart`;break b;case`compositionend`:b=`onCompositionEnd`;break b;case`compositionupdate`:b=`onCompositionUpdate`;break b}b=void 0}else Cr?xr(e,n)&&(b=`onCompositionEnd`):e===`keydown`&&n.keyCode===229&&(b=`onCompositionStart`);b&&(vr&&n.locale!==`ko`&&(Cr||b!==`onCompositionStart`?b===`onCompositionEnd`&&Cr&&(y=Ln()):(Pn=i,Fn=`value`in Pn?Pn.value:Pn.textContent,Cr=!0)),v=Jf(r,b),0<v.length&&(b=new tr(b,e,null,n,i),o.push({event:b,listeners:v}),y?b.data=y:(y=Sr(n),y!==null&&(b.data=y)))),(y=_r?wr(e,n):Tr(e,n))&&(b=Jf(r,`onBeforeInput`),0<b.length&&(v=new tr(`onBeforeInput`,`beforeinput`,null,n,i),o.push({event:v,listeners:b}),v.data=y)),If(o,e,r,n,i)}Vf(o,t)})}function qf(e,t,n){return{instance:e,listener:t,currentTarget:n}}function Jf(e,t){for(var n=t+`Capture`,r=[];e!==null;){var i=e,a=i.stateNode;if(i=i.tag,i!==5&&i!==26&&i!==27||a===null||(i=An(e,n),i!=null&&r.unshift(qf(e,i,a)),i=An(e,t),i!=null&&r.push(qf(e,i,a))),e.tag===3)return r;e=e.return}return[]}function Yf(e){if(e===null)return null;do e=e.return;while(e&&e.tag!==5&&e.tag!==27);return e||null}function Xf(e,t,n,r,i){for(var a=t._reactName,o=[];n!==null&&n!==r;){var s=n,c=s.alternate,l=s.stateNode;if(s=s.tag,c!==null&&c===r)break;s!==5&&s!==26&&s!==27||l===null||(c=l,i?(l=An(n,a),l!=null&&o.unshift(qf(n,l,c))):i||(l=An(n,a),l!=null&&o.push(qf(n,l,c)))),n=n.return}o.length!==0&&e.push({event:t,listeners:o})}var Zf=/\\r\\n?/g,Qf=/\\u0000|\\uFFFD/g;function $f(e){return(typeof e==`string`?e:``+e).replace(Zf,`\n`).replace(Qf,``)}function ep(e,t){return t=$f(t),$f(e)===t}function $(e,t,n,r,i,a){switch(n){case`children`:if(typeof r==`string`)t===`body`||t===`textarea`&&r===``||hn(e,r);else if(typeof r==`number`||typeof r==`bigint`)t!==`body`&&hn(e,``+r);else return;break;case`className`:en(e,`class`,r);break;case`tabIndex`:en(e,`tabindex`,r);break;case`dir`:case`role`:case`viewBox`:case`width`:case`height`:en(e,n,r);break;case`style`:_n(e,r,a);return;case`data`:if(t!==`object`){en(e,`data`,r);break}case`src`:case`href`:if(r===``&&(t!==`a`||n!==`href`)||r==null||typeof r==`function`||typeof r==`symbol`||typeof r==`boolean`){e.removeAttribute(n);break}r=xn(r),e.setAttribute(n,r);break;case`action`:case`formAction`:if(typeof r==`function`){e.setAttribute(n,`javascript:throw new Error(\'A React form was unexpectedly submitted. If you called form.submit() manually, consider using form.requestSubmit() instead. If you\\\\\'re trying to use event.stopPropagation() in a submit event handler, consider also calling event.preventDefault().\')`);break}if(typeof a==`function`&&(n===`formAction`?(t!==`input`&&$(e,t,`name`,i.name,i,null),$(e,t,`formEncType`,i.formEncType,i,null),$(e,t,`formMethod`,i.formMethod,i,null),$(e,t,`formTarget`,i.formTarget,i,null)):($(e,t,`encType`,i.encType,i,null),$(e,t,`method`,i.method,i,null),$(e,t,`target`,i.target,i,null))),r==null||typeof r==`symbol`||typeof r==`boolean`){e.removeAttribute(n);break}r=xn(r),e.setAttribute(n,r);break;case`onClick`:r!=null&&(e.onclick=Sn);return;case`onScroll`:r!=null&&Q(`scroll`,e);return;case`onScrollEnd`:r!=null&&Q(`scrollend`,e);return;case`dangerouslySetInnerHTML`:if(r!=null){if(typeof r!=`object`||!(`__html`in r))throw Error(s(61));if(n=r.__html,n!=null){if(i.children!=null)throw Error(s(60));a?.__html!==n&&(e.innerHTML=n)}}break;case`multiple`:e.multiple=r&&typeof r!=`function`&&typeof r!=`symbol`;break;case`muted`:e.muted=r&&typeof r!=`function`&&typeof r!=`symbol`;break;case`suppressContentEditableWarning`:case`suppressHydrationWarning`:case`defaultValue`:case`defaultChecked`:case`innerHTML`:case`ref`:break;case`autoFocus`:break;case`xlinkHref`:if(r==null||typeof r==`function`||typeof r==`boolean`||typeof r==`symbol`){e.removeAttribute(`xlink:href`);break}n=xn(r),e.setAttributeNS(`http://www.w3.org/1999/xlink`,`xlink:href`,n);break;case`contentEditable`:case`spellCheck`:case`draggable`:case`value`:case`autoReverse`:case`externalResourcesRequired`:case`focusable`:case`preserveAlpha`:r!=null&&typeof r!=`function`&&typeof r!=`symbol`?e.setAttribute(n,r):e.removeAttribute(n);break;case`inert`:case`allowFullScreen`:case`async`:case`autoPlay`:case`controls`:case`credentialless`:case`default`:case`defer`:case`disabled`:case`disablePictureInPicture`:case`disableRemotePlayback`:case`formNoValidate`:case`hidden`:case`loop`:case`noModule`:case`noValidate`:case`open`:case`playsInline`:case`readOnly`:case`required`:case`reversed`:case`scoped`:case`seamless`:case`itemScope`:r&&typeof r!=`function`&&typeof r!=`symbol`?e.setAttribute(n,``):e.removeAttribute(n);break;case`capture`:case`download`:!0===r?e.setAttribute(n,``):!1!==r&&r!=null&&typeof r!=`function`&&typeof r!=`symbol`?e.setAttribute(n,r):e.removeAttribute(n);break;case`cols`:case`rows`:case`size`:case`span`:r!=null&&typeof r!=`function`&&typeof r!=`symbol`&&!isNaN(r)&&1<=r?e.setAttribute(n,r):e.removeAttribute(n);break;case`rowSpan`:case`start`:r==null||typeof r==`function`||typeof r==`symbol`||isNaN(r)?e.removeAttribute(n):e.setAttribute(n,r);break;case`popover`:Q(`beforetoggle`,e),Q(`toggle`,e),$t(e,`popover`,r);break;case`xlinkActuate`:P(e,`http://www.w3.org/1999/xlink`,`xlink:actuate`,r);break;case`xlinkArcrole`:P(e,`http://www.w3.org/1999/xlink`,`xlink:arcrole`,r);break;case`xlinkRole`:P(e,`http://www.w3.org/1999/xlink`,`xlink:role`,r);break;case`xlinkShow`:P(e,`http://www.w3.org/1999/xlink`,`xlink:show`,r);break;case`xlinkTitle`:P(e,`http://www.w3.org/1999/xlink`,`xlink:title`,r);break;case`xlinkType`:P(e,`http://www.w3.org/1999/xlink`,`xlink:type`,r);break;case`xmlBase`:P(e,`http://www.w3.org/XML/1998/namespace`,`xml:base`,r);break;case`xmlLang`:P(e,`http://www.w3.org/XML/1998/namespace`,`xml:lang`,r);break;case`xmlSpace`:P(e,`http://www.w3.org/XML/1998/namespace`,`xml:space`,r);break;case`is`:$t(e,`is`,r);break;case`innerText`:case`textContent`:return;default:if(!(2<n.length)||n[0]!==`o`&&n[0]!==`O`||n[1]!==`n`&&n[1]!==`N`)n=yn.get(n)||n,$t(e,n,r);else return}N=!0}function tp(e,t,n,r,i,a){switch(n){case`style`:_n(e,r,a);return;case`dangerouslySetInnerHTML`:if(r!=null){if(typeof r!=`object`||!(`__html`in r))throw Error(s(61));if(n=r.__html,n!=null){if(i.children!=null)throw Error(s(60));a?.__html!==n&&(e.innerHTML=n)}}break;case`children`:if(typeof r==`string`)hn(e,r);else if(typeof r==`number`||typeof r==`bigint`)hn(e,``+r);else return;break;case`onScroll`:r!=null&&Q(`scroll`,e);return;case`onScrollEnd`:r!=null&&Q(`scrollend`,e);return;case`onClick`:r!=null&&(e.onclick=Sn);return;case`suppressContentEditableWarning`:case`suppressHydrationWarning`:case`innerHTML`:case`ref`:return;case`innerText`:case`textContent`:return;default:if(!Gt.hasOwnProperty(n))a:{if(n[0]===`o`&&n[1]===`n`&&(i=n.endsWith(`Capture`),a=n.slice(2,i?n.length-7:void 0),t=e[kt]||null,t=t==null?null:t[n],typeof t==`function`&&e.removeEventListener(a,t,i),typeof r==`function`)){typeof t!=`function`&&t!==null&&(n in e?e[n]=null:e.hasAttribute(n)&&e.removeAttribute(n)),e.addEventListener(a,r,i);break a}N=!0,n in e?e[n]=r:!0===r?e.setAttribute(n,``):$t(e,n,r)}return}N=!0}function np(e,t,n){switch(t){case`div`:case`span`:case`svg`:case`path`:case`a`:case`g`:case`p`:case`li`:break;case`img`:Q(`error`,e),Q(`load`,e);var r=!1,i=!1,a;for(a in n)if(n.hasOwnProperty(a)){var o=n[a];if(o!=null)switch(a){case`src`:r=!0;break;case`srcSet`:i=!0;break;case`children`:case`dangerouslySetInnerHTML`:throw Error(s(137,t));default:$(e,t,a,o,n,null)}}i&&$(e,t,`srcSet`,n.srcSet,n,null),r&&$(e,t,`src`,n.src,n,null);return;case`input`:Q(`invalid`,e);var c=a=o=i=null,l=null,u=null;for(r in n)if(n.hasOwnProperty(r)){var d=n[r];if(d!=null)switch(r){case`name`:i=d;break;case`type`:o=d;break;case`checked`:l=d;break;case`defaultChecked`:u=d;break;case`value`:a=d;break;case`defaultValue`:c=d;break;case`children`:case`dangerouslySetInnerHTML`:if(d!=null)throw Error(s(137,t));break;default:$(e,t,r,d,n,null)}}un(e,a,c,l,u,o,i,!1);return;case`select`:for(i in Q(`invalid`,e),r=o=a=null,n)if(n.hasOwnProperty(i)&&(c=n[i],c!=null))switch(i){case`value`:a=c;break;case`defaultValue`:o=c;break;case`multiple`:r=c;default:$(e,t,i,c,n,null)}t=a,n=o,e.multiple=!!r,t==null?n!=null&&fn(e,!!r,n,!0):fn(e,!!r,t,!1);return;case`textarea`:for(o in Q(`invalid`,e),a=i=r=null,n)if(n.hasOwnProperty(o)&&(c=n[o],c!=null))switch(o){case`value`:r=c;break;case`defaultValue`:i=c;break;case`children`:a=c;break;case`dangerouslySetInnerHTML`:if(c!=null)throw Error(s(91));break;default:$(e,t,o,c,n,null)}mn(e,r,i,a);return;case`option`:for(l in n)if(n.hasOwnProperty(l)&&(r=n[l],r!=null))switch(l){case`selected`:e.selected=r&&typeof r!=`function`&&typeof r!=`symbol`;break;default:$(e,t,l,r,n,null)}return;case`dialog`:Q(`beforetoggle`,e),Q(`toggle`,e),Q(`cancel`,e),Q(`close`,e);break;case`iframe`:case`object`:Q(`load`,e);break;case`video`:case`audio`:for(r=0;r<zf.length;r++)Q(zf[r],e);break;case`image`:Q(`error`,e),Q(`load`,e);break;case`details`:Q(`toggle`,e);break;case`embed`:case`source`:case`link`:Q(`error`,e),Q(`load`,e);case`area`:case`base`:case`br`:case`col`:case`hr`:case`keygen`:case`meta`:case`param`:case`track`:case`wbr`:case`menuitem`:for(u in n)if(n.hasOwnProperty(u)&&(r=n[u],r!=null))switch(u){case`children`:case`dangerouslySetInnerHTML`:throw Error(s(137,t));default:$(e,t,u,r,n,null)}return;default:if(vn(t)){for(d in n)n.hasOwnProperty(d)&&(r=n[d],r!==void 0&&tp(e,t,d,r,n,void 0));return}}for(c in n)n.hasOwnProperty(c)&&(r=n[c],r!=null&&$(e,t,c,r,n,null))}var rp={};function ip(e,t,n,r){switch(t){case`div`:case`span`:case`svg`:case`path`:case`a`:case`g`:case`p`:case`li`:break;case`input`:var i=null,a=null,o=null,c=null,l=null,u=null,d=null;for(m in n){var f=n[m];if(n.hasOwnProperty(m)&&f!=null)switch(m){case`checked`:break;case`value`:break;case`defaultValue`:l=f;default:r.hasOwnProperty(m)||$(e,t,m,null,r,f)}}for(var p in r){var m=r[p];if(f=n[p],r.hasOwnProperty(p)&&(m!=null||f!=null))switch(p){case`type`:m!==f&&(N=!0),a=m;break;case`name`:m!==f&&(N=!0),i=m;break;case`checked`:m!==f&&(N=!0),u=m;break;case`defaultChecked`:m!==f&&(N=!0),d=m;break;case`value`:m!==f&&(N=!0),o=m;break;case`defaultValue`:m!==f&&(N=!0),c=m;break;case`children`:case`dangerouslySetInnerHTML`:if(m!=null)throw Error(s(137,t));break;default:m!==f&&$(e,t,p,m,r,f)}}ln(e,o,c,l,u,d,a,i);return;case`select`:for(a in m=o=c=p=null,n)if(l=n[a],n.hasOwnProperty(a)&&l!=null)switch(a){case`value`:break;case`multiple`:m=l;default:r.hasOwnProperty(a)||$(e,t,a,null,r,l)}for(i in r)if(a=r[i],l=n[i],r.hasOwnProperty(i)&&(a!=null||l!=null))switch(i){case`value`:a!==l&&(N=!0),p=a;break;case`defaultValue`:a!==l&&(N=!0),c=a;break;case`multiple`:a!==l&&(N=!0),o=a;default:a!==l&&$(e,t,i,a,r,l)}t=c,n=o,r=m,p==null?!!r!=!!n&&(t==null?fn(e,!!n,n?[]:``,!1):fn(e,!!n,t,!0)):fn(e,!!n,p,!1);return;case`textarea`:for(c in m=p=null,n)if(i=n[c],n.hasOwnProperty(c)&&i!=null&&!r.hasOwnProperty(c))switch(c){case`value`:break;case`children`:break;default:$(e,t,c,null,r,i)}for(o in r)if(i=r[o],a=n[o],r.hasOwnProperty(o)&&(i!=null||a!=null))switch(o){case`value`:i!==a&&(N=!0),p=i;break;case`defaultValue`:i!==a&&(N=!0),m=i;break;case`children`:break;case`dangerouslySetInnerHTML`:if(i!=null)throw Error(s(91));break;default:i!==a&&$(e,t,o,i,r,a)}pn(e,p,m);return;case`option`:for(var h in n)if(p=n[h],n.hasOwnProperty(h)&&p!=null&&!r.hasOwnProperty(h))switch(h){case`selected`:e.selected=!1;break;default:$(e,t,h,null,r,p)}for(l in r)if(p=r[l],m=n[l],r.hasOwnProperty(l)&&p!==m&&(p!=null||m!=null))switch(l){case`selected`:p!==m&&(N=!0),e.selected=p&&typeof p!=`function`&&typeof p!=`symbol`;break;default:$(e,t,l,p,r,m)}return;case`img`:case`link`:case`area`:case`base`:case`br`:case`col`:case`embed`:case`hr`:case`keygen`:case`meta`:case`param`:case`source`:case`track`:case`wbr`:case`menuitem`:for(var g in n)p=n[g],n.hasOwnProperty(g)&&p!=null&&!r.hasOwnProperty(g)&&$(e,t,g,null,r,p);for(u in r)if(p=r[u],m=n[u],r.hasOwnProperty(u)&&p!==m&&(p!=null||m!=null))switch(u){case`children`:case`dangerouslySetInnerHTML`:if(p!=null)throw Error(s(137,t));break;default:$(e,t,u,p,r,m)}return;default:if(vn(t)){for(var _ in n)p=n[_],n.hasOwnProperty(_)&&p!==void 0&&!r.hasOwnProperty(_)&&tp(e,t,_,void 0,r,p);for(d in r)p=r[d],m=n[d],!r.hasOwnProperty(d)||p===m||p===void 0&&m===void 0||tp(e,t,d,p,r,m);return}}for(var v in n)p=n[v],n.hasOwnProperty(v)&&p!=null&&!r.hasOwnProperty(v)&&$(e,t,v,null,r,p);for(f in r)p=r[f],m=n[f],!r.hasOwnProperty(f)||p===m||p==null&&m==null||$(e,t,f,p,r,m)}function ap(e){switch(e){case`css`:case`script`:case`font`:case`img`:case`image`:case`input`:case`link`:return!0;default:return!1}}function op(){if(typeof performance.getEntriesByType==`function`){for(var e=0,t=0,n=performance.getEntriesByType(`resource`),r=0;r<n.length;r++){var i=n[r],a=i.transferSize,o=i.initiatorType,s=i.duration;if(a&&s&&ap(o)){for(o=0,s=i.responseEnd,r+=1;r<n.length;r++){var c=n[r],l=c.startTime;if(l>s)break;var u=c.transferSize,d=c.initiatorType;u&&ap(d)&&(c=c.responseEnd,o+=u*(c<s?1:(s-l)/(c-l)))}if(--r,t+=8*(a+o)/(i.duration/1e3),e++,10<e)break}}if(0<e)return t/e/1e6}return navigator.connection&&(e=navigator.connection.downlink,typeof e==`number`)?e:5}var sp=null,cp=null;function lp(e){return e.nodeType===9?e:e.ownerDocument}function up(e){switch(e){case`http://www.w3.org/2000/svg`:return 1;case`http://www.w3.org/1998/Math/MathML`:return 2;default:return 0}}function dp(e,t){if(e===0)switch(t){case`svg`:return 1;case`math`:return 2;default:return 0}return e===1&&t===`foreignObject`?0:e}function fp(e,t,n,r){return n=lp(n).createElement(e),n[Ot]=r,n[kt]=t,np(n,e,t),Ht(n),n}function pp(e,t){return e===`textarea`||e===`noscript`||typeof t.children==`string`||typeof t.children==`number`||typeof t.children==`bigint`||typeof t.dangerouslySetInnerHTML==`object`&&t.dangerouslySetInnerHTML!==null&&t.dangerouslySetInnerHTML.__html!=null}var mp=null;function hp(){var e=window.event;return e&&e.type===`popstate`?e!==mp&&(mp=e,!0):(mp=null,!1)}var gp=typeof setTimeout==`function`?setTimeout:void 0,_p=typeof clearTimeout==`function`?clearTimeout:void 0,vp=typeof Promise==`function`?Promise:void 0,yp=typeof requestAnimationFrame==`function`?requestAnimationFrame:gp,bp=typeof queueMicrotask==`function`?queueMicrotask:vp===void 0?gp:function(e){return vp.resolve(null).then(e).catch(xp)};function xp(e){setTimeout(function(){throw e})}function Sp(e){return e===`head`}function Cp(e,t){var n=t,r=0;do{var i=n.nextSibling;if(e.removeChild(n),i&&i.nodeType===8){if(n=i.data,n===`/$`||n===`/&`){if(r===0){e.removeChild(i),Hh(t);return}r--}else if(n===`$`||n===`$?`||n===`$~`||n===`$!`||n===`&`)r++;else if(n===`html`)_m(e.ownerDocument.documentElement);else if(n===`head`){n=e.ownerDocument.head,_m(n);for(var a=n.firstChild;a;){var o=a.nextSibling,s=a.nodeName;a[Ft]||s===`SCRIPT`||s===`STYLE`||s===`LINK`&&a.rel.toLowerCase()===`stylesheet`||n.removeChild(a),a=o}}else n===`body`&&_m(e.ownerDocument.body)}n=i}while(n);Hh(t)}function wp(e,t){var n=e;e=0;do{var r=n.nextSibling;if(n.nodeType===1?t?(n._stashedDisplay=n.style.display,n.style.display=`none`):(n.style.display=n._stashedDisplay||``,n.getAttribute(`style`)===``&&n.removeAttribute(`style`)):n.nodeType===3&&(t?(n._stashedText=n.nodeValue,n.nodeValue=``):n.nodeValue=n._stashedText||``),r&&r.nodeType===8){if(n=r.data,n===`/$`){if(e===0)break;e--}else n!==`$`&&n!==`$?`&&n!==`$~`&&n!==`$!`||e++}n=r}while(n)}function Tp(e,t,n){if(t=CSS.escape(t)===t?t:`r-`+btoa(t).replace(/=/g,``),e.style.viewTransitionName=t,n!=null&&(e.style.viewTransitionClass=n),n=getComputedStyle(e),n.display===`inline`){if(t=e.getClientRects(),t.length===1)var r=1;else for(var i=r=0;i<t.length;i++){var a=t[i];0<a.width&&0<a.height&&r++}r===1&&(e=e.style,e.display=t.length===1?`inline-block`:`block`,e.marginTop=`-`+n.paddingTop,e.marginBottom=`-`+n.paddingBottom)}}function Ep(e,t){e=e.style,t=t.style;var n=t==null?null:t.hasOwnProperty(`viewTransitionName`)?t.viewTransitionName:t.hasOwnProperty(`view-transition-name`)?t[`view-transition-name`]:null;e.viewTransitionName=n==null||typeof n==`boolean`?``:(``+n).trim(),n=t==null?null:t.hasOwnProperty(`viewTransitionClass`)?t.viewTransitionClass:t.hasOwnProperty(`view-transition-class`)?t[`view-transition-class`]:null,e.viewTransitionClass=n==null||typeof n==`boolean`?``:(``+n).trim(),e.display===`inline-block`&&(t==null?e.display=e.margin=``:(n=t.display,e.display=n==null||typeof n==`boolean`?``:n,n=t.margin,n==null?(n=t.hasOwnProperty(`marginTop`)?t.marginTop:t[`margin-top`],e.marginTop=n==null||typeof n==`boolean`?``:n,t=t.hasOwnProperty(`marginBottom`)?t.marginBottom:t[`margin-bottom`],e.marginBottom=t==null||typeof t==`boolean`?``:t):e.margin=n))}function Dp(e,t,n){return n=n.ownerDocument.defaultView,{rect:e,abs:t.position===`absolute`||t.position===`fixed`,clip:t.clipPath!==`none`||t.overflow!==`visible`||t.filter!==`none`||t.mask!==`none`||t.mask!==`none`||t.borderRadius!==`0px`,view:0<=e.bottom&&0<=e.right&&e.top<=n.innerHeight&&e.left<=n.innerWidth}}function Op(e){return Dp(e.getBoundingClientRect(),getComputedStyle(e),e)}function kp(e){var t=e.getBoundingClientRect();t=new DOMRect(t.x+2e4,t.y+2e4,t.width,t.height);var n=getComputedStyle(e);return Dp(t,n,e)}function Ap(e){return e.documentElement.clientHeight}function jp(e){this.addEventListener(`load`,e),this.addEventListener(`error`,e)}function Mp(e,t,n,r,i,a,o,s,c){var l=t.nodeType===9?t:t.ownerDocument;try{var u=l.startViewTransition({update:function(){var t=l.defaultView,n=t.navigation&&t.navigation.transition,o=l.fonts.status;r();var s=[];if(o===`loaded`&&(Ap(l),l.fonts.status===`loading`&&s.push(l.fonts.ready)),o=s.length,e!==null)for(var c=e.suspenseyImages,u=0,d=0;d<c.length;d++){var f=c[d];if(!f.complete){var p=f.getBoundingClientRect();if(0<p.bottom&&0<p.right&&p.top<t.innerHeight&&p.left<t.innerWidth){if(u+=Xm(f),u>$m){s.length=o;break}f=new Promise(jp.bind(f)),s.push(f)}}}if(0<s.length)return t=Promise.race([Promise.all(s),new Promise(function(e){return setTimeout(e,500)})]).then(i,i),(n?Promise.allSettled([n.finished,t]):t).then(a,a);if(i(),n)return n.finished.then(a,a);a()},types:n});l.__reactViewTransition=u;var d=[];return u.ready.then(function(){for(var e=l.documentElement.getAnimations({subtree:!0}),t=0;t<e.length;t++){var n=e[t],r=n.effect,i=r.pseudoElement;if(i!=null&&i.startsWith(`::view-transition`)){d.push(n),n=r.getKeyframes();for(var a=i=void 0,s=!0,c=0;c<n.length;c++){var u=n[c],f=u.width;if(i===void 0)i=f;else if(i!==f){s=!1;break}if(f=u.height,a===void 0)a=f;else if(a!==f){s=!1;break}delete u.width,delete u.height,u.transform===`none`&&delete u.transform}s&&i!==void 0&&a!==void 0&&(r.setKeyframes(n),s=getComputedStyle(r.target,r.pseudoElement),s.width!==i||s.height!==a)&&(s=n[0],s.width=i,s.height=a,s=n[n.length-1],s.width=i,s.height=a,r.setKeyframes(n))}}o()},function(e){l.__reactViewTransition===u&&(l.__reactViewTransition=null);try{if(typeof e==`object`&&e)switch(e.name){case`InvalidStateError`:(e.message===`View transition was skipped because document visibility state is hidden.`||e.message===`Skipping view transition because document visibility state has become hidden.`||e.message===`Skipping view transition because viewport size changed.`||e.message===`Transition was aborted because of invalid state`)&&(e=null)}e!==null&&c(e)}finally{r(),i(),o()}}),u.finished.finally(function(){for(var e=0;e<d.length;e++)d[e].cancel();l.__reactViewTransition===u&&(l.__reactViewTransition=null),s()}),u}catch{return r(),i(),o(),null}}function Np(e,t){this._scope=document.documentElement,this._selector=`::view-transition-`+e+`(`+t+`)`}Np.prototype.animate=function(e,t){return t=typeof t==`number`?{duration:t}:C({},t),t.pseudoElement=this._selector,this._scope.animate(e,t)},Np.prototype.getAnimations=function(){for(var e=this._scope,t=this._selector,n=e.getAnimations({subtree:!0}),r=[],i=0;i<n.length;i++){var a=n[i].effect;a!==null&&a.target===e&&a.pseudoElement===t&&r.push(n[i])}return r},Np.prototype.getComputedStyle=function(){return getComputedStyle(this._scope,this._selector)};function Pp(e){return{name:e,group:new Np(`group`,e),imagePair:new Np(`image-pair`,e),old:new Np(`old`,e),new:new Np(`new`,e)}}function Fp(e){this._fragmentFiber=e,this._observers=this._eventListeners=null}Fp.prototype.addEventListener=function(e,t,n){var r=null,i=null;if(!(n!=null&&typeof n!=`boolean`&&(r=n.signal||null,r!==null&&r.aborted))){this._eventListeners===null&&(this._eventListeners=[]);var a=this._eventListeners;if(Bp(a,e,t,n)===-1){var o=this,s=t;n!=null&&typeof n!=`boolean`&&!0===n.once&&(s=function(r){o.removeEventListener(e,t,n),typeof t==`function`?t.call(this,r):t.handleEvent(r)}),r!==null&&(i=o.removeEventListener.bind(o,e,t,n),r.addEventListener(`abort`,i,{once:!0}),i=r.removeEventListener.bind(r,`abort`,i)),r=Rp(n),a.push({type:e,listener:t,optionsOrUseCapture:n,attachedListener:s,cleanup:i}),h(this._fragmentFiber.child,!1,Ip,e,s,r)}this._eventListeners=a}};function Ip(e,t,n,r){return b(e).addEventListener(t,n,r),!1}Fp.prototype.removeEventListener=function(e,t,n){var r=this._eventListeners;if(r!==null&&(t=Bp(r,e,t,n),t!==-1)){var i=r[t];n=i.attachedListener;var a=i.cleanup;i=Rp(i.optionsOrUseCapture),h(this._fragmentFiber.child,!1,Lp,e,n,i),r.splice(t,1),a!==null&&a()}};function Lp(e,t,n,r){return b(e).removeEventListener(t,n,r),!1}function Rp(e){return e!=null&&typeof e!=`boolean`&&(!0===e.once||e.signal instanceof AbortSignal)?{capture:e.capture,passive:e.passive}:e}function zp(e){return e==null?`c=0`:typeof e==`boolean`?`c=`+(e?`1`:`0`):`c=`+(e.capture?`1`:`0`)}function Bp(e,t,n,r){if(e.length===0)return-1;r=zp(r);for(var i=0;i<e.length;i++){var a=e[i];if(a.type===t&&a.listener===n&&zp(a.optionsOrUseCapture)===r)return i}return-1}Fp.prototype.dispatchEvent=function(e){var t=g(this._fragmentFiber);if(t===null)return!0;t=b(t);var n=this._eventListeners;if(n!==null&&0<n.length||!e.bubbles){var r=t.nodeType===9?t.createComment(``):document.createTextNode(``);if(n)for(var i=0;i<n.length;i++){var a=n[i];r.addEventListener(a.type,a.attachedListener,Rp(a.optionsOrUseCapture))}if(t.appendChild(r),e=r.dispatchEvent(e),n)for(i=0;i<n.length;i++)a=n[i],r.removeEventListener(a.type,a.attachedListener,Rp(a.optionsOrUseCapture));return t.removeChild(r),e}return t.dispatchEvent(e)},Fp.prototype.focus=function(e){h(this._fragmentFiber.child,!0,Vp,e,void 0,void 0)};function Vp(e,t){return e.tag!==6&&(e=b(e),pm(e,t))}Fp.prototype.focusLast=function(e){var t=[];h(this._fragmentFiber.child,!0,Hp,t,void 0,void 0);for(var n=t.length-1;0<=n&&!Vp(t[n],e);n--);};function Hp(e,t){return t.push(e),!1}Fp.prototype.blur=function(){var e=g(this._fragmentFiber);e!==null&&(e=b(e),e=lp(e).activeElement,e!==null&&h(this._fragmentFiber.child,!1,Up,e,void 0,void 0))};function Up(e,t){return e.tag!==6&&(e=b(e),e===t||e.contains(t)?(t.blur(),!0):!1)}Fp.prototype.observeUsing=function(e){this._observers===null&&(this._observers=new Set),this._observers.add(e),h(this._fragmentFiber.child,!1,Wp,e,void 0,void 0)};function Wp(e,t){return e.tag===6||(e=b(e),t.observe(e)),!1}Fp.prototype.unobserveUsing=function(e){var t=this._observers;if(t!==null&&t.has(e)){t.delete(e),h(this._fragmentFiber.child,!1,Gp,e,void 0,void 0);for(var n=t=0;n<Kp.length;n++){var r=Kp[n];r.fragmentInstance===this&&r.observer===e?e.unobserve(r.instance):Kp[t++]=r}Kp.length=t}};function Gp(e,t){return e.tag===6||(e=b(e),t.unobserve(e)),!1}var Kp=[],qp=!1;function Jp(e,t,n){Kp.push({fragmentInstance:e,observer:t,instance:n}),qp||(qp=!0,mm(function(){qp=!1;var e=Kp;Kp=[];for(var t=0;t<e.length;t++){var n=e[t];n.observer.unobserve(n.instance)}}))}Fp.prototype.getClientRects=function(){var e=[];return h(this._fragmentFiber.child,!1,Yp,e,void 0,void 0),e};function Yp(e,t){if(e.tag===6){e=e.stateNode;var n=e.ownerDocument.createRange();n.selectNodeContents(e),t.push.apply(t,n.getClientRects())}else e=b(e),t.push.apply(t,e.getClientRects());return!1}Fp.prototype.getRootNode=function(e){var t=g(this._fragmentFiber);return t===null?this:b(t).getRootNode(e)},Fp.prototype.compareDocumentPosition=function(e){var t=g(this._fragmentFiber);if(t===null)return Node.DOCUMENT_POSITION_DISCONNECTED;var n=[];h(this._fragmentFiber.child,!1,Hp,n,void 0,void 0);var r=b(t);if(n.length===0){if(n=r,_(this._fragmentFiber)){a:{for(t=this._fragmentFiber.return;t!==null;){if(t.tag===4){t=t.stateNode.containerInfo;break a}if(t.tag===3||t.tag===5||t.tag===27)break;t=t.return}t=null}t!=null&&(n=t)}t=this._fragmentFiber;var i=r=n.compareDocumentPosition(e);return n===e?i=Node.DOCUMENT_POSITION_CONTAINS:r&Node.DOCUMENT_POSITION_CONTAINED_BY&&(n=v(t)[1],n===null?i=Node.DOCUMENT_POSITION_PRECEDING:(e=b(n).compareDocumentPosition(e),i=e===0||e&Node.DOCUMENT_POSITION_FOLLOWING?Node.DOCUMENT_POSITION_FOLLOWING:Node.DOCUMENT_POSITION_PRECEDING)),i|=Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC}t=b(n[0]),i=b(n[n.length-1]);var a=_(this._fragmentFiber)?t.parentElement:r;if(a==null)return Node.DOCUMENT_POSITION_DISCONNECTED;r=a.compareDocumentPosition(t)&Node.DOCUMENT_POSITION_CONTAINED_BY,a=a.compareDocumentPosition(i)&Node.DOCUMENT_POSITION_CONTAINED_BY;var o=t.compareDocumentPosition(e),s=i.compareDocumentPosition(e),c=o&Node.DOCUMENT_POSITION_CONTAINED_BY||s&Node.DOCUMENT_POSITION_CONTAINED_BY;return s=r&&a&&o&Node.DOCUMENT_POSITION_FOLLOWING&&s&Node.DOCUMENT_POSITION_PRECEDING,t=r&&t===e||a&&i===e||c||s?Node.DOCUMENT_POSITION_CONTAINED_BY:!r&&t===e||!a&&i===e?Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC:o,t&Node.DOCUMENT_POSITION_DISCONNECTED||t&Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC||Xp(t,this._fragmentFiber,n[0],n[n.length-1],e)?t:Node.DOCUMENT_POSITION_IMPLEMENTATION_SPECIFIC};function Xp(e,t,n,r,i){var a=Rt(i);if(e&Node.DOCUMENT_POSITION_CONTAINED_BY){if(n=!!a)a:{for(;a!==null;){if(a.tag===7&&(a===t||a.alternate===t)){n=!0;break a}a=a.return}n=!1}return n}if(e&Node.DOCUMENT_POSITION_CONTAINS){if(a===null)return a=i.ownerDocument,i===a||i===a.documentElement||i===a.body;a:{for(a=t,t=g(t);a!==null;){if(!(a.tag!==5&&a.tag!==3&&a.tag!==27||a!==t&&a.alternate!==t)){a=!0;break a}a=a.return}a=!1}return a}return e&Node.DOCUMENT_POSITION_PRECEDING?((t=!!a)&&!(t=a===n)&&(t=re(n,a,S),t===null?t=!1:(h(t,!0,ne,a,n),a=ee,ee=null,t=a!==null)),t):e&Node.DOCUMENT_POSITION_FOLLOWING?((t=!!a)&&!(t=a===r)&&(t=re(r,a,S),t===null?t=!1:(h(t,!0,x,a,r),a=ee,te=ee=null,t=a!==null)),t):!1}function Zp(e,t){var n=e.ownerDocument.createRange();n.selectNodeContents(e),e=n.getBoundingClientRect(),window.scrollTo(window.scrollX+e.left,t?window.scrollY+e.top:window.scrollY+e.bottom-window.innerHeight)}Fp.prototype.scrollIntoView=function(e){if(typeof e==`object`)throw Error(s(566));var t=[];h(this._fragmentFiber.child,!1,Hp,t,void 0,void 0);var n=!1!==e;if(t.length===0){var r=v(this._fragmentFiber);if(r=n?r[1]||r[0]||g(this._fragmentFiber):r[0]||r[1],r===null)return;if(r.tag===6){e=b(r),Zp(e,n);return}if(r=b(r),r.nodeType!==9){if(r.nodeType===11){n=`host`in r?r.host:null,n!==null&&n.scrollIntoView(e);return}r.scrollIntoView(e)}}for(r=n?t.length-1:0;r!==(n?-1:t.length);){var i=t[r];i.tag===6?(i=b(i),Zp(i,n)):b(i).scrollIntoView(e),r+=n?-1:1}};function Qp(e,t){return e=b(e),$p(e,t),!1}function $p(e,t){e.reactFragments??=new Set,e.reactFragments.add(t)}function em(e,t){var n=t._eventListeners;if(n!==null)for(var r=0;r<n.length;r++){var i=n[r];e.addEventListener(i.type,i.attachedListener,Rp(i.optionsOrUseCapture))}e.nodeType!==3&&(n=t._observers,n!==null&&n.forEach(function(n){for(var r=0,i=0;i<Kp.length;i++){var a=Kp[i];(a.fragmentInstance!==t||a.observer!==n||a.instance!==e)&&(Kp[r++]=a)}Kp.length=r,n.observe(e)}),$p(e,t))}function tm(e,t){var n=t._eventListeners;if(n!==null)for(var r=0;r<n.length;r++){var i=n[r];e.removeEventListener(i.type,i.attachedListener,Rp(i.optionsOrUseCapture))}e.nodeType!==3&&(n=t._observers,n!==null&&n.forEach(function(n){typeof n.rootMargin==`string`?Jp(t,n,e):n.unobserve(e)}),e.reactFragments!=null&&e.reactFragments.delete(t))}function nm(e){var t=e.firstChild;for(t&&t.nodeType===10&&(t=t.nextSibling);t;){var n=t;switch(t=t.nextSibling,n.nodeName){case`HTML`:case`HEAD`:case`BODY`:nm(n),Lt(n);continue;case`SCRIPT`:case`STYLE`:continue;case`LINK`:if(n.rel.toLowerCase()===`stylesheet`)continue}e.removeChild(n)}}function rm(e,t,n,r){for(;e.nodeType===1;){var i=n;if(e.nodeName.toLowerCase()!==t.toLowerCase()){if(!r&&(e.nodeName!==`INPUT`||e.type!==`hidden`))break}else if(!r){if(t===`input`&&e.type===`hidden`){var a=i.name==null?null:``+i.name;if(i.type===`hidden`&&e.getAttribute(`name`)===a)return e}else return e}else if(!e[Ft])switch(t){case`meta`:if(!e.hasAttribute(`itemprop`))break;return e;case`link`:if(a=e.getAttribute(`rel`),a===`stylesheet`&&e.hasAttribute(`data-precedence`)||a!==i.rel||e.getAttribute(`href`)!==(i.href==null||i.href===``?null:i.href)||e.getAttribute(`crossorigin`)!==(i.crossOrigin==null?null:i.crossOrigin)||e.getAttribute(`title`)!==(i.title==null?null:i.title))break;return e;case`style`:if(e.hasAttribute(`data-precedence`))break;return e;case`script`:if(a=e.getAttribute(`src`),(a!==(i.src==null?null:i.src)||e.getAttribute(`type`)!==(i.type==null?null:i.type)||e.getAttribute(`crossorigin`)!==(i.crossOrigin==null?null:i.crossOrigin))&&a&&e.hasAttribute(`async`)&&!e.hasAttribute(`itemprop`))break;return e;default:return e}if(e=lm(e.nextSibling),e===null)break}return null}function im(e,t,n){if(t===``)return null;for(;e.nodeType!==3;)if((e.nodeType!==1||e.nodeName!==`INPUT`||e.type!==`hidden`)&&!n||(e=lm(e.nextSibling),e===null))return null;return e}function am(e,t){for(;e.nodeType!==8;)if((e.nodeType!==1||e.nodeName!==`INPUT`||e.type!==`hidden`)&&!t||(e=lm(e.nextSibling),e===null))return null;return e}function om(e){return e.data===`$?`||e.data===`$~`}function sm(e){return e.data===`$!`||e.data===`$?`&&e.ownerDocument.readyState!==`loading`}function cm(e,t){var n=e.ownerDocument;if(e.data===`$~`)e._reactRetry=t;else if(e.data!==`$?`||n.readyState!==`loading`)t();else{var r=function(){t(),n.removeEventListener(`DOMContentLoaded`,r)};n.addEventListener(`DOMContentLoaded`,r),e._reactRetry=r}}function lm(e){for(;e!=null;e=e.nextSibling){var t=e.nodeType;if(t===1||t===3)break;if(t===8){if(t=e.data,t===`$`||t===`$!`||t===`$?`||t===`$~`||t===`&`||t===`F!`||t===`F`)break;if(t===`/$`||t===`/&`)return null}}return e}var um=null;function dm(e){e=e.nextSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n===`/$`||n===`/&`){if(t===0)return lm(e.nextSibling);t--}else n!==`$`&&n!==`$!`&&n!==`$?`&&n!==`$~`&&n!==`&`||t++}e=e.nextSibling}return null}function fm(e){e=e.previousSibling;for(var t=0;e;){if(e.nodeType===8){var n=e.data;if(n===`$`||n===`$!`||n===`$?`||n===`$~`||n===`&`){if(t===0)return e;t--}else n!==`/$`&&n!==`/&`||t++}e=e.previousSibling}return null}function pm(e,t){function n(){r=!0}if(e.ownerDocument.activeElement===e)return!0;var r=!1;try{e.ownerDocument.addEventListener(`focus`,n,!0),(e.focus||HTMLElement.prototype.focus).call(e,t)}finally{e.ownerDocument.removeEventListener(`focus`,n,!0)}return r}function mm(e){yp(function(){yp(function(t){return e(t)})})}function hm(e,t,n){switch(t=lp(n),e){case`html`:if(e=t.documentElement,!e)throw Error(s(452));return e;case`head`:if(e=t.head,!e)throw Error(s(453));return e;case`body`:if(e=t.body,!e)throw Error(s(454));return e;default:throw Error(s(451))}}function gm(e,t,n){for(var r in n){var i=n[r];n.hasOwnProperty(r)&&i!=null&&$(e,t,r,null,rp,i)}n.dangerouslySetInnerHTML!=null&&(e.textContent=``),e.onclick===Sn&&(e.onclick=null),Lt(e)}function _m(e){for(var t=e.attributes;t.length;)e.removeAttributeNode(t[0]);Lt(e)}var vm=new Map,ym=new Set;function bm(e){if(typeof e.getRootNode==`function`){var t=e.getRootNode();if(t.nodeType===9||t.nodeType===11)return t}return e.nodeType===9?e:e.ownerDocument}var xm=E.d;E.d={f:Sm,r:Cm,D:Em,C:Dm,L:Om,m:km,X:jm,S:Am,M:Mm};function Sm(){var e=xm.f(),t=zd();return e||t}function Cm(e){var t=zt(e);t!==null&&t.tag===5&&t.type===`form`?ac(t):xm.r(e)}var wm=typeof document>`u`?null:document;function Tm(e,t,n){var r=wm;if(r&&typeof t==`string`&&t){var i=cn(t);i=`link[rel="`+e+`"][href="`+i+`"]`,typeof n==`string`&&(i+=`[crossorigin="`+n+`"]`),ym.has(i)||(ym.add(i),e={rel:e,crossOrigin:n,href:t},r.querySelector(i)===null&&(t=r.createElement(`link`),np(t,`link`,e),Ht(t),r.head.appendChild(t)))}}function Em(e){xm.D(e),Tm(`dns-prefetch`,e,null)}function Dm(e,t){xm.C(e,t),Tm(`preconnect`,e,t)}function Om(e,t,n){xm.L(e,t,n);var r=wm;if(r&&e&&t){var i=`link[rel="preload"][as="`+cn(t)+`"]`;t===`image`&&n&&n.imageSrcSet?(i+=`[imagesrcset="`+cn(n.imageSrcSet)+`"]`,typeof n.imageSizes==`string`&&(i+=`[imagesizes="`+cn(n.imageSizes)+`"]`)):i+=`[href="`+cn(e)+`"]`;var a=i;switch(t){case`style`:a=Pm(e);break;case`script`:a=Rm(e)}if(!(vm.has(a)||(e=C({rel:`preload`,href:t===`image`&&n&&n.imageSrcSet?void 0:e,as:t},n),vm.set(a,e),r.querySelector(i)!==null||t===`style`&&r.querySelector(Fm(a))||t===`script`&&r.querySelector(zm(a))))){var o=r.createElement(`link`);np(o,`link`,e),t===`style`&&(o[It]=!0,o.onload=o.onerror=function(){Ut(o)}),Ht(o),r.head.appendChild(o)}}}function km(e,t){xm.m(e,t);var n=wm;if(n&&e){var r=t&&typeof t.as==`string`?t.as:`script`,i=`link[rel="modulepreload"][as="`+cn(r)+`"][href="`+cn(e)+`"]`,a=i;switch(r){case`audioworklet`:case`paintworklet`:case`serviceworker`:case`sharedworker`:case`worker`:case`script`:a=Rm(e)}if(!vm.has(a)&&(e=C({rel:`modulepreload`,href:e},t),vm.set(a,e),n.querySelector(i)===null)){switch(r){case`audioworklet`:case`paintworklet`:case`serviceworker`:case`sharedworker`:case`worker`:case`script`:if(n.querySelector(zm(a)))return}r=n.createElement(`link`),np(r,`link`,e),Ht(r),n.head.appendChild(r)}}}function Am(e,t,n){xm.S(e,t,n);var r=wm;if(r&&e){var i=Vt(r).hoistableStyles,a=Pm(e);t||=`default`;var o=i.get(a);if(!o){var s={loading:0,preload:null};if(o=r.querySelector(Fm(a)))s.loading=5;else{e=C({rel:`stylesheet`,href:e,"data-precedence":t},n),(n=vm.get(a))&&Hm(e,n);var c=o=r.createElement(`link`);Ht(c),np(c,`link`,e),c._p=new Promise(function(e,t){c.onload=e,c.onerror=t}),c.addEventListener(`load`,function(){s.loading|=1}),c.addEventListener(`error`,function(){s.loading|=2}),s.loading|=4,Vm(o,t,r)}o={type:`stylesheet`,instance:o,count:1,state:s},i.set(a,o)}}}function jm(e,t){xm.X(e,t);var n=wm;if(n&&e){var r=Vt(n).hoistableScripts,i=Rm(e),a=r.get(i);a||(a=n.querySelector(zm(i)),a||(e=C({src:e,async:!0},t),(t=vm.get(i))&&Um(e,t),a=n.createElement(`script`),Ht(a),np(a,`link`,e),n.head.appendChild(a)),a={type:`script`,instance:a,count:1,state:null},r.set(i,a))}}function Mm(e,t){xm.M(e,t);var n=wm;if(n&&e){var r=Vt(n).hoistableScripts,i=Rm(e),a=r.get(i);a||(a=n.querySelector(zm(i)),a||(e=C({src:e,async:!0,type:`module`},t),(t=vm.get(i))&&Um(e,t),a=n.createElement(`script`),Ht(a),np(a,`link`,e),n.head.appendChild(a)),a={type:`script`,instance:a,count:1,state:null},r.set(i,a))}}function Nm(e,t,n,r){var i=(i=je.current)?bm(i):null;if(!i)throw Error(s(446));switch(e){case`meta`:case`title`:return null;case`style`:return typeof n.precedence==`string`&&typeof n.href==`string`?(n=Pm(n.href),t=Vt(i).hoistableStyles,r=t.get(n),r||(r={type:`style`,instance:null,count:0,state:null},t.set(n,r)),r):{type:`void`,instance:null,count:0,state:null};case`link`:if(n.rel===`stylesheet`&&typeof n.href==`string`&&typeof n.precedence==`string`){e=Pm(n.href);var a=Vt(i).hoistableStyles,o=a.get(e);if(o||(i=i.ownerDocument||i,o={type:`stylesheet`,instance:null,count:0,state:{loading:0,preload:null}},a.set(e,o),(a=i.querySelector(Fm(e)))?a._p||(o.instance=a,o.state.loading=5):(a=vm.get(e),a||(a={rel:`preload`,as:`style`,href:n.href,crossOrigin:n.crossOrigin,integrity:n.integrity,media:n.media,hrefLang:n.hrefLang,referrerPolicy:n.referrerPolicy},vm.set(e,a)),Lm(i,e,a,o.state))),t&&r===null)throw Error(s(528,``));return o}if(t&&r!==null)throw Error(s(529,``));return null;case`script`:return t=n.async,n=n.src,typeof n==`string`&&t&&typeof t!=`function`&&typeof t!=`symbol`?(n=Rm(n),t=Vt(i).hoistableScripts,r=t.get(n),r||(r={type:`script`,instance:null,count:0,state:null},t.set(n,r)),r):{type:`void`,instance:null,count:0,state:null};default:throw Error(s(444,e))}}function Pm(e){return`href="`+cn(e)+`"`}function Fm(e){return`link[rel="stylesheet"][`+e+`]`}function Im(e){return C({},e,{"data-precedence":e.precedence,precedence:null})}function Lm(e,t,n,r){if(t=e.querySelector(`link[rel="preload"][as="style"][`+t+`]`)){if(!0!==t[It]){r.loading=1;return}}else t=e.createElement(`link`),t[It]=!0,t.onload=t.onerror=Ut.bind(null,t),np(t,`link`,n),Ht(t),e.head.appendChild(t);r.preload=t,t.addEventListener(`load`,function(){return r.loading|=1}),t.addEventListener(`error`,function(){return r.loading|=2})}function Rm(e){return`[src="`+cn(e)+`"]`}function zm(e){return`script[async]`+e}function Bm(e,t,n){if(t.count++,t.instance===null)switch(t.type){case`style`:var r=e.querySelector(`style[data-href~="`+cn(n.href)+`"]`);if(r)return t.instance=r,Ht(r),r;var i=C({},n,{"data-href":n.href,"data-precedence":n.precedence,href:null,precedence:null});return r=(e.ownerDocument||e).createElement(`style`),Ht(r),np(r,`style`,i),Vm(r,n.precedence,e),t.instance=r;case`stylesheet`:i=Pm(n.href);var a=e.querySelector(Fm(i));if(a)return t.state.loading|=4,t.instance=a,Ht(a),a;r=Im(n),(i=vm.get(i))&&Hm(r,i),a=(e.ownerDocument||e).createElement(`link`),Ht(a);var o=a;return o._p=new Promise(function(e,t){o.onload=e,o.onerror=t}),np(a,`link`,r),t.state.loading|=4,Vm(a,n.precedence,e),t.instance=a;case`script`:return a=Rm(n.src),(i=e.querySelector(zm(a)))?(t.instance=i,Ht(i),i):(r=n,(i=vm.get(a))&&(r=C({},n),Um(r,i)),e=e.ownerDocument||e,i=e.createElement(`script`),Ht(i),np(i,`link`,r),e.head.appendChild(i),t.instance=i);case`void`:return null;default:throw Error(s(443,t.type))}else t.type===`stylesheet`&&!(t.state.loading&4)&&(r=t.instance,t.state.loading|=4,Vm(r,n.precedence,e));return t.instance}function Vm(e,t,n){for(var r=n.querySelectorAll(`link[rel="stylesheet"][data-precedence],style[data-precedence]`),i=r.length?r[r.length-1]:null,a=i,o=0;o<r.length;o++){var s=r[o];if(s.dataset.precedence===t)a=s;else if(a!==i)break}a?a.parentNode.insertBefore(e,a.nextSibling):(t=n.nodeType===9?n.head:n,t.insertBefore(e,t.firstChild))}function Hm(e,t){e.crossOrigin??=t.crossOrigin,e.referrerPolicy??=t.referrerPolicy,e.title??=t.title}function Um(e,t){e.crossOrigin??=t.crossOrigin,e.referrerPolicy??=t.referrerPolicy,e.integrity??=t.integrity}var Wm=null;function Gm(e,t,n){if(Wm===null){var r=new Map,i=Wm=new Map;i.set(n,r)}else i=Wm,r=i.get(n),r||(r=new Map,i.set(n,r));if(r.has(e))return r;for(r.set(e,null),n=n.getElementsByTagName(e),i=0;i<n.length;i++){var a=n[i];if(!(a[Ft]||a[Ot]||e===`link`&&a.getAttribute(`rel`)===`stylesheet`)&&a.namespaceURI!==`http://www.w3.org/2000/svg`){var o=a.getAttribute(t)||``;o=e+o;var s=r.get(o);s?s.push(a):r.set(o,[a])}}return r}function Km(e,t,n){e=e.ownerDocument||e,e.head.insertBefore(n,t===`title`?e.querySelector(`head > title`):null)}function qm(e,t,n){if(n===1||t.itemProp!=null)return!1;switch(e){case`meta`:case`title`:return!0;case`style`:if(typeof t.precedence!=`string`||typeof t.href!=`string`||t.href===``)break;return!0;case`link`:if(typeof t.rel!=`string`||typeof t.href!=`string`||t.href===``||t.onLoad||t.onError)break;switch(t.rel){case`stylesheet`:return e=t.disabled,typeof t.precedence==`string`&&e==null;default:return!0}case`script`:if(t.async&&typeof t.async!=`function`&&typeof t.async!=`symbol`&&!t.onLoad&&!t.onError&&t.src&&typeof t.src==`string`)return!0}return!1}function Jm(e,t){return e===`img`&&t.src!=null&&t.src!==``&&t.onLoad==null&&t.loading!==`lazy`}function Ym(e){return!(e.type===`stylesheet`&&!(e.state.loading&3))}function Xm(e){return(e.width||100)*(e.height||100)*(typeof devicePixelRatio==`number`?devicePixelRatio:1)*.25}function Zm(e,t){typeof t.decode==`function`&&(e.imgCount++,t.complete||(e.imgBytes+=Xm(t),e.suspenseyImages.push(t)),e=rh.bind(e),t.decode().then(e,e))}function Qm(e,t,n,r){if(n.type===`stylesheet`&&(typeof r.media!=`string`||!1!==matchMedia(r.media).matches)&&!(n.state.loading&4)){if(n.instance===null){var i=Pm(r.href),a=t.querySelector(Fm(i));if(a){t=a._p,typeof t==`object`&&t&&typeof t.then==`function`&&(e.count++,e=nh.bind(e),t.then(e,e)),n.state.loading|=4,n.instance=a,Ht(a);return}a=t.ownerDocument||t,r=Im(r),(i=vm.get(i))&&Hm(r,i),a=a.createElement(`link`),Ht(a);var o=a;o._p=new Promise(function(e,t){o.onload=e,o.onerror=t}),np(a,`link`,r),n.instance=a}e.stylesheets===null&&(e.stylesheets=new Map),e.stylesheets.set(n,t),(t=n.state.preload)&&!(n.state.loading&3)&&(e.count++,n=nh.bind(e),t.addEventListener(`load`,n),t.addEventListener(`error`,n))}}var $m=0;function eh(e,t){return e.stylesheets&&e.count===0&&ah(e,e.stylesheets),0<e.count||0<e.imgCount?function(n){var r=setTimeout(function(){if(e.stylesheets&&ah(e,e.stylesheets),e.unsuspend){var t=e.unsuspend;e.unsuspend=null,t()}},6e4+t);0<e.imgBytes&&$m===0&&($m=62500*op());var i=setTimeout(function(){if(e.waitingForImages=!1,e.count===0&&(e.stylesheets&&ah(e,e.stylesheets),e.unsuspend)){var t=e.unsuspend;e.unsuspend=null,t()}},(e.imgBytes>$m?50:800)+t);return e.unsuspend=n,function(){e.unsuspend=null,clearTimeout(r),clearTimeout(i)}}:null}function th(e){if(e.count===0&&(e.imgCount===0||!e.waitingForImages)){if(e.stylesheets)ah(e,e.stylesheets);else if(e.unsuspend){var t=e.unsuspend;e.unsuspend=null,t()}}}function nh(){this.count--,th(this)}function rh(){this.imgCount--,th(this)}var ih=null;function ah(e,t){e.stylesheets=null,e.unsuspend!==null&&(e.count++,ih=new Map,t.forEach(oh,e),ih=null,nh.call(e))}function oh(e,t){if(!(t.state.loading&4)){var n=ih.get(e);if(n)var r=n.get(null);else{n=new Map,ih.set(e,n);for(var i=e.querySelectorAll(`link[data-precedence],style[data-precedence]`),a=0;a<i.length;a++){var o=i[a];(o.nodeName===`LINK`||o.getAttribute(`media`)!==`not all`)&&(n.set(o.dataset.precedence,o),r=o)}r&&n.set(null,r)}i=t.instance,o=i.getAttribute(`data-precedence`),a=n.get(o)||r,a===r&&n.set(null,i),n.set(o,i),this.count++,r=nh.bind(this),i.addEventListener(`load`,r),i.addEventListener(`error`,r),a?a.parentNode.insertBefore(i,a.nextSibling):(e=e.nodeType===9?e.head:e,e.insertBefore(i,e.firstChild)),t.state.loading|=4}}var sh={$$typeof:de,Provider:null,Consumer:null,_currentValue:Ee,_currentValue2:Ee,_threadCount:0};function ch(e,t,n,r,i,a,o,s,c){this.tag=1,this.containerInfo=e,this.pingCache=this.current=this.pendingChildren=null,this.timeoutHandle=-1,this.callbackNode=this.next=this.pendingContext=this.context=this.cancelPendingCommit=null,this.callbackPriority=0,this.expirationTimes=_t(-1),this.entangledLanes=this.shellSuspendCounter=this.errorRecoveryDisabledLanes=this.expiredLanes=this.warmLanes=this.pingedLanes=this.suspendedLanes=this.pendingLanes=0,this.entanglements=_t(0),this.hiddenUpdates=_t(null),this.identifierPrefix=r,this.onUncaughtError=i,this.onCaughtError=a,this.onRecoverableError=o,this.pooledCache=null,this.pooledCacheLanes=0,this.formState=c,this.transitionTypes=null,this.incompleteTransitions=new Map}function lh(e,t,n,r,i,a,o,s,c,l,u,d){return e=new ch(e,t,n,o,c,l,u,d,s),t=1,!0===a&&(t|=24),a=Ii(3,null,null,t),e.current=a,a.stateNode=e,t=Fa(),t.refCount++,e.pooledCache=t,t.refCount++,a.memoizedState={element:r,isDehydrated:n,cache:t},vo(a),e}function uh(e){return e?(e=Pi,e):Pi}function dh(e,t,n,r,i,a){i=uh(i),r.context===null?r.context=i:r.pendingContext=i,r=bo(t),r.payload={element:n},a=a===void 0?null:a,a!==null&&(r.callback=a),n=xo(e,r,t),n!==null&&(Pd(n,e,t),So(n,e,t))}function fh(e,t){if(e=e.memoizedState,e!==null&&e.dehydrated!==null){var n=e.retryLane;e.retryLane=n!==0&&n<t?n:t}}function ph(e,t){fh(e,t),(e=e.alternate)&&fh(e,t)}function mh(e){if(e.tag===13||e.tag===31){var t=ji(e,67108864);t!==null&&Pd(t,e,67108864),ph(e,67108864)}}function hh(e){if(e.tag===13||e.tag===31){var t=jd();t=Ct(t);var n=ji(e,t);n!==null&&Pd(n,e,t),ph(e,t)}}var gh=!0;function _h(e,t,n,r){var i=T.T;T.T=null;var a=E.p;try{E.p=2,yh(e,t,n,r)}finally{E.p=a,T.T=i}}function vh(e,t,n,r){var i=T.T;T.T=null;var a=E.p;try{E.p=8,yh(e,t,n,r)}finally{E.p=a,T.T=i}}function yh(e,t,n,r){if(gh){var i=bh(r);if(i===null)Kf(e,t,r,xh,n),Mh(e,r);else if(Ph(i,e,t,n,r))r.stopPropagation();else if(Mh(e,r),t&4&&-1<jh.indexOf(e)){for(;i!==null;){var a=zt(i);if(a!==null)switch(a.tag){case 3:if(a=a.stateNode,a.current.memoizedState.isDehydrated){var o=dt(a.pendingLanes);if(o!==0){var s=a;for(s.pendingLanes|=2,s.entangledLanes|=2;o;){var c=1<<31-at(o);s.entanglements[1]|=c,o&=~c}Ef(a),!(W&6)&&(_d=qe()+500,Df(0,!1))}}break;case 31:case 13:s=ji(a,2),s!==null&&Pd(s,a,2),zd(),ph(a,2)}if(a=bh(r),a===null&&Kf(e,t,r,xh,n),a===i)break;i=a}i!==null&&r.stopPropagation()}else Kf(e,t,r,null,n)}}function bh(e){return e=wn(e),Sh(e)}var xh=null;function Sh(e){if(xh=null,e=Rt(e),e!==null){var t=l(e);if(t===null)e=null;else{var n=t.tag;if(n===13){if(e=u(t),e!==null)return e;e=null}else if(n===31){if(e=d(t),e!==null)return e;e=null}else if(n===3){if(t.stateNode.current.memoizedState.isDehydrated)return t.tag===3?t.stateNode.containerInfo:null;e=null}else t!==e&&(e=null)}}return xh=e,null}function Ch(e){switch(e){case`beforetoggle`:case`cancel`:case`click`:case`close`:case`contextmenu`:case`copy`:case`cut`:case`auxclick`:case`dblclick`:case`dragend`:case`dragstart`:case`drop`:case`focusin`:case`focusout`:case`input`:case`invalid`:case`keydown`:case`keypress`:case`keyup`:case`mousedown`:case`mouseup`:case`paste`:case`pause`:case`play`:case`pointercancel`:case`pointerdown`:case`pointerup`:case`ratechange`:case`reset`:case`seeked`:case`submit`:case`toggle`:case`touchcancel`:case`touchend`:case`touchstart`:case`volumechange`:case`change`:case`selectionchange`:case`textInput`:case`compositionstart`:case`compositionend`:case`compositionupdate`:case`beforeblur`:case`afterblur`:case`beforeinput`:case`blur`:case`fullscreenchange`:case`fullscreenerror`:case`focus`:case`hashchange`:case`popstate`:case`select`:case`selectstart`:return 2;case`drag`:case`dragenter`:case`dragexit`:case`dragleave`:case`dragover`:case`mousemove`:case`mouseout`:case`mouseover`:case`pointermove`:case`pointerout`:case`pointerover`:case`resize`:case`scroll`:case`touchmove`:case`wheel`:case`mouseenter`:case`mouseleave`:case`pointerenter`:case`pointerleave`:return 8;case`message`:switch(Je()){case Ye:return 2;case Xe:return 8;case Ze:case Qe:return 32;case $e:return 268435456;default:return 32}default:return 32}}var wh=!1,Th=null,Eh=null,Dh=null,Oh=new Map,kh=new Map,Ah=[],jh=`mousedown mouseup touchcancel touchend touchstart auxclick dblclick pointercancel pointerdown pointerup dragend dragstart drop compositionend compositionstart keydown keypress keyup input textInput copy cut paste click change contextmenu reset`.split(` `);function Mh(e,t){switch(e){case`focusin`:case`focusout`:Th=null;break;case`dragenter`:case`dragleave`:Eh=null;break;case`mouseover`:case`mouseout`:Dh=null;break;case`pointerover`:case`pointerout`:Oh.delete(t.pointerId);break;case`gotpointercapture`:case`lostpointercapture`:kh.delete(t.pointerId)}}function Nh(e,t,n,r,i,a){return e===null||e.nativeEvent!==a?(e={blockedOn:t,domEventName:n,eventSystemFlags:r,nativeEvent:a,targetContainers:[i]},t!==null&&(t=zt(t),t!==null&&mh(t)),e):(e.eventSystemFlags|=r,t=e.targetContainers,i!==null&&t.indexOf(i)===-1&&t.push(i),e)}function Ph(e,t,n,r,i){switch(t){case`focusin`:return Th=Nh(Th,e,t,n,r,i),!0;case`dragenter`:return Eh=Nh(Eh,e,t,n,r,i),!0;case`mouseover`:return Dh=Nh(Dh,e,t,n,r,i),!0;case`pointerover`:var a=i.pointerId;return Oh.set(a,Nh(Oh.get(a)||null,e,t,n,r,i)),!0;case`gotpointercapture`:return a=i.pointerId,kh.set(a,Nh(kh.get(a)||null,e,t,n,r,i)),!0}return!1}function Fh(e){var t=Rt(e.target);if(t!==null){var n=l(t);if(n!==null){if(t=n.tag,t===13){if(t=u(n),t!==null){e.blockedOn=t,Et(e.priority,function(){hh(n)});return}}else if(t===31){if(t=d(n),t!==null){e.blockedOn=t,Et(e.priority,function(){hh(n)});return}}else if(t===3&&n.stateNode.current.memoizedState.isDehydrated){e.blockedOn=n.tag===3?n.stateNode.containerInfo:null;return}}}e.blockedOn=null}function Ih(e){if(e.blockedOn!==null)return!1;for(var t=e.targetContainers;0<t.length;){var n=bh(e.nativeEvent);if(n===null){n=e.nativeEvent;var r=new n.constructor(n.type,n);Cn=r,n.target.dispatchEvent(r),Cn=null}else return t=zt(n),t!==null&&mh(t),e.blockedOn=n,!1;t.shift()}return!0}function Lh(e,t,n){Ih(e)&&n.delete(t)}function Rh(){wh=!1,Th!==null&&Ih(Th)&&(Th=null),Eh!==null&&Ih(Eh)&&(Eh=null),Dh!==null&&Ih(Dh)&&(Dh=null),Oh.forEach(Lh),kh.forEach(Lh)}function zh(e,n){e.blockedOn===n&&(e.blockedOn=null,wh||(wh=!0,t.unstable_scheduleCallback(t.unstable_NormalPriority,Rh)))}var Bh=null;function Vh(e){Bh!==e&&(Bh=e,t.unstable_scheduleCallback(t.unstable_NormalPriority,function(){Bh===e&&(Bh=null);for(var t=0;t<e.length;t+=3){var n=e[t],r=e[t+1],i=e[t+2];if(typeof r!=`function`){if(Sh(r||n)===null)continue;break}var a=zt(n);a!==null&&(e.splice(t,3),t-=3,rc(a,{pending:!0,data:i,method:n.method,action:r},r,i))}}))}function Hh(e){function t(t){return zh(t,e)}Th!==null&&zh(Th,e),Eh!==null&&zh(Eh,e),Dh!==null&&zh(Dh,e),Oh.forEach(t),kh.forEach(t);for(var n=0;n<Ah.length;n++){var r=Ah[n];r.blockedOn===e&&(r.blockedOn=null)}for(;0<Ah.length&&(n=Ah[0],n.blockedOn===null);)Fh(n),n.blockedOn===null&&Ah.shift();if(n=(e.ownerDocument||e).$$reactFormReplay,n!=null)for(r=0;r<n.length;r+=3){var i=n[r],a=n[r+1],o=i[kt]||null;if(typeof a==`function`)o||Vh(n);else if(o){var s=null;if(a&&a.hasAttribute(`formAction`)){if(i=a,o=a[kt]||null)s=o.formAction;else if(Sh(i)!==null)continue}else s=o.action;typeof s==`function`?n[r+1]=s:(n.splice(r,3),r-=3),Vh(n)}}}function Uh(){function e(e){e.canIntercept&&e.info===`react-transition`&&e.intercept({handler:function(){return new Promise(function(e){return i=e})},focusReset:`manual`,scroll:`manual`})}function t(){i!==null&&(i(),i=null),r||setTimeout(n,20)}function n(){if(!r&&!navigation.transition){var e=navigation.currentEntry;e&&e.url!=null&&navigation.navigate(e.url,{state:e.getState(),info:`react-transition`,history:`replace`})}}if(typeof navigation==`object`){var r=!1,i=null;return navigation.addEventListener(`navigate`,e),navigation.addEventListener(`navigatesuccess`,t),navigation.addEventListener(`navigateerror`,t),setTimeout(n,100),function(){r=!0,navigation.removeEventListener(`navigate`,e),navigation.removeEventListener(`navigatesuccess`,t),navigation.removeEventListener(`navigateerror`,t),i!==null&&(i(),i=null)}}}function Wh(e){this._internalRoot=e}Gh.prototype.render=Wh.prototype.render=function(e){var t=this._internalRoot;if(t===null)throw Error(s(409));var n=t.current;dh(n,jd(),e,t,null,null)},Gh.prototype.unmount=Wh.prototype.unmount=function(){var e=this._internalRoot;if(e!==null){this._internalRoot=null;var t=e.containerInfo;dh(e.current,2,null,e,null,null),zd(),t[At]=null}};function Gh(e){this._internalRoot=e}Gh.prototype.unstable_scheduleHydration=function(e){if(e){var t=Tt();e={blockedOn:null,target:e,priority:t};for(var n=0;n<Ah.length&&t!==0&&t<Ah[n].priority;n++);Ah.splice(n,0,e),n===0&&Fh(e)}};var Kh=r.version;if(Kh!==`19.3.1`)throw Error(s(527,Kh,`19.3.1`));E.findDOMNode=function(e){var t=e._reactInternals;if(t===void 0)throw typeof e.render==`function`?Error(s(188)):(e=Object.keys(e).join(`,`),Error(s(268,e)));return e=p(t),e=e===null?null:m(e),e=e===null?null:e.stateNode,e};var qh={bundleType:0,version:`19.3.1`,rendererPackageName:`react-dom`,currentDispatcherRef:T,reconcilerVersion:`19.3.1`};if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<`u`){var Jh=__REACT_DEVTOOLS_GLOBAL_HOOK__;if(!Jh.isDisabled&&Jh.supportsFiber)try{nt=Jh.inject(qh),rt=Jh}catch{}}e.createRoot=function(e,t){if(!c(e))throw Error(s(299));var n=!1,r=``,i=Ec,a=Dc,o=Oc;return t!=null&&(!0===t.unstable_strictMode&&(n=!0),t.identifierPrefix!==void 0&&(r=t.identifierPrefix),t.onUncaughtError!==void 0&&(i=t.onUncaughtError),t.onCaughtError!==void 0&&(a=t.onCaughtError),t.onRecoverableError!==void 0&&(o=t.onRecoverableError)),t=lh(e,1,!1,null,null,n,r,null,i,a,o,Uh),e[At]=t.current,Wf(e),new Wh(t)}})),c=e(((e,t)=>{function n(){if(typeof __REACT_DEVTOOLS_GLOBAL_HOOK__<`u`&&typeof __REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE==`function`)try{__REACT_DEVTOOLS_GLOBAL_HOOK__.checkDCE(n)}catch(e){console.error(e)}}n(),t.exports=s()})),l=n(),u=c();function d(e){var t,n,r=``;if(typeof e==`string`||typeof e==`number`)r+=e;else if(typeof e==`object`){if(Array.isArray(e)){var i=e.length;for(t=0;t<i;t++)e[t]&&(n=d(e[t]))&&(r&&(r+=` `),r+=n)}else for(n in e)e[n]&&(r&&(r+=` `),r+=n)}return r}function f(){for(var e,t,n=0,r=``,i=arguments.length;n<i;n++)(e=arguments[n])&&(t=d(e))&&(r&&(r+=` `),r+=t);return r}var p=(e,t)=>{let n=Array(e.length+t.length);for(let t=0;t<e.length;t++)n[t]=e[t];for(let r=0;r<t.length;r++)n[e.length+r]=t[r];return n},m=(e,t)=>({classGroupId:e,validator:t}),h=(e=new Map,t=null,n)=>({nextPart:e,validators:t,classGroupId:n}),g=`-`,_=[],v=`arbitrary..`,y=e=>{let t=te(e),{conflictingClassGroups:n,conflictingClassGroupModifiers:r}=e;return{getClassGroupId:e=>{if(e.startsWith(`[`)&&e.endsWith(`]`))return ee(e);let n=e.split(g);return b(n,+(n[0]===``&&n.length>1),t)},getConflictingClassGroupIds:(e,t)=>{if(t){let t=r[e],i=n[e];return t?i?p(i,t):t:i||_}return n[e]||_}}},b=(e,t,n)=>{if(e.length-t===0)return n.classGroupId;let r=e[t],i=n.nextPart.get(r);if(i){let n=b(e,t+1,i);if(n)return n}let a=n.validators;if(a===null)return;let o=t===0?e.join(g):e.slice(t).join(g),s=a.length;for(let e=0;e<s;e++){let t=a[e];if(t.validator(o))return t.classGroupId}},ee=e=>e.slice(1,-1).indexOf(`:`)===-1?void 0:(()=>{let t=e.slice(1,-1),n=t.indexOf(`:`),r=t.slice(0,n);return r?v+r:void 0})(),te=e=>{let{theme:t,classGroups:n}=e;return ne(n,t)},ne=(e,t)=>{let n=h();for(let r in e){let i=e[r];x(i,n,r,t)}return n},x=(e,t,n,r)=>{let i=e.length;for(let a=0;a<i;a++){let i=e[a];S(i,t,n,r)}},S=(e,t,n,r)=>{typeof e==`string`?re(e,t,n):typeof e==`function`?C(e,t,n,r):ie(e,t,n,r)},re=(e,t,n)=>{let r=e===``?t:ae(t,e);r.classGroupId=n},C=(e,t,n,r)=>{oe(e)?x(e(r),t,n,r):(t.validators===null&&(t.validators=[]),t.validators.push(m(n,e)))},ie=(e,t,n,r)=>{let i=Object.entries(e),a=i.length;for(let e=0;e<a;e++){let[a,o]=i[e];x(o,ae(t,a),n,r)}},ae=(e,t)=>{let n=e,r=t.split(g),i=r.length;for(let e=0;e<i;e++){let t=r[e],i=n.nextPart.get(t);i||(i=h(),n.nextPart.set(t,i)),n=i}return n},oe=e=>`isThemeGetter`in e&&e.isThemeGetter===!0,se=e=>{if(e<1)return{get:()=>void 0,set:()=>{}};let t=0,n=Object.create(null),r=Object.create(null),i=(i,a)=>{n[i]=a,t++,t>e&&(t=0,r=n,n=Object.create(null))};return{get(e){let t=n[e];if(t!==void 0)return t;if((t=r[e])!==void 0)return i(e,t),t},set(e,t){e in n?n[e]=t:i(e,t)}}},ce=`!`,le=`:`,ue=[],de=(e,t,n,r,i)=>({modifiers:e,hasImportantModifier:t,baseClassName:n,maybePostfixModifierPosition:r,isExternal:i}),w=e=>{let{prefix:t,experimentalParseClassName:n}=e,r=e=>{let t=[],n=0,r=0,i=0,a,o=e.length;for(let s=0;s<o;s++){let o=e[s];if(n===0&&r===0){if(o===le){t.push(e.slice(i,s)),i=s+1;continue}if(o===`/`){a=s;continue}}o===`[`?n++:o===`]`?n--:o===`(`?r++:o===`)`&&r--}let s=t.length===0?e:e.slice(i),c=s,l=!1;s.endsWith(ce)?(c=s.slice(0,-1),l=!0):s.startsWith(ce)&&(c=s.slice(1),l=!0);let u=a&&a>i?a-i:void 0;return de(t,l,c,u)};if(t){let e=t+le,n=r;r=t=>t.startsWith(e)?n(t.slice(e.length)):de(ue,!1,t,void 0,!0)}if(n){let e=r;r=t=>n({className:t,parseClassName:e})}return r},fe=e=>{let t=new Map;return e.orderSensitiveModifiers.forEach((e,n)=>{t.set(e,1e6+n)}),e=>{let n=[],r=[];for(let i=0;i<e.length;i++){let a=e[i],o=a[0]===`[`,s=t.has(a);o||s?(r.length>0&&(r.sort(),n.push(...r),r=[]),n.push(a)):r.push(a)}return r.length>0&&(r.sort(),n.push(...r)),n}},pe=e=>({cache:se(e.cacheSize),parseClassName:w(e),sortModifiers:fe(e),postfixLookupClassGroupIds:me(e),...y(e)}),me=e=>{let t=Object.create(null),n=e.postfixLookupClassGroups;if(n)for(let e=0;e<n.length;e++)t[n[e]]=!0;return t},he=/\\s+/,ge=(e,t)=>{let{parseClassName:n,getClassGroupId:r,getConflictingClassGroupIds:i,sortModifiers:a,postfixLookupClassGroupIds:o}=t,s=[],c=e.trim().split(he),l=``;for(let e=c.length-1;e>=0;--e){let t=c[e],{isExternal:u,modifiers:d,hasImportantModifier:f,baseClassName:p,maybePostfixModifierPosition:m}=n(t);if(u){l=t+(l.length>0?` `+l:l);continue}let h=!!m,g;if(h){g=r(p.substring(0,m));let e=g&&o[g]?r(p):void 0;e&&e!==g&&(g=e,h=!1)}else g=r(p);if(!g){if(!h||(g=r(p),!g)){l=t+(l.length>0?` `+l:l);continue}h=!1}let _=d.length===0?``:d.length===1?d[0]:a(d).join(`:`),v=f?_+ce:_,y=v+g;if(s.indexOf(y)>-1)continue;s.push(y);let b=i(g,h);for(let e=0;e<b.length;++e){let t=b[e];s.push(v+t)}l=t+(l.length>0?` `+l:l)}return l},_e=(...e)=>{let t=0,n,r,i=``;for(;t<e.length;)(n=e[t++])&&(r=ve(n))&&(i&&(i+=` `),i+=r);return i},ve=e=>{if(typeof e==`string`)return e;let t,n=``;for(let r=0;r<e.length;r++)e[r]&&(t=ve(e[r]))&&(n&&(n+=` `),n+=t);return n},ye=(e,...t)=>{let n,r,i,a,o=o=>(n=pe(t.reduce((e,t)=>t(e),e())),r=n.cache.get,i=n.cache.set,a=s,s(o)),s=e=>{let t=r(e);if(t)return t;let a=ge(e,n);return i(e,a),a};return a=o,(...e)=>a(_e(...e))},be=[],xe=e=>{let t=t=>t[e]||be;return t.isThemeGetter=!0,t.themeKey=e,t},Se=/^\\[(?:(\\w[\\w-]*):)?(.+)\\]$/i,Ce=/^\\((?:(\\w[\\w-]*):)?(.+)\\)$/i,we=/^\\d+(?:\\.\\d+)?\\/\\d+(?:\\.\\d+)?$/,Te=/^(\\d+(\\.\\d+)?)?(xs|sm|md|lg|xl)$/,T=/\\d+(%|px|r?em|[sdl]?v([hwib]|min|max)|pt|pc|in|cm|mm|cap|ch|ex|r?lh|cq(w|h|i|b|min|max))|\\b(calc|min|max|clamp)\\(.+\\)|^0$/,E=/^(rgba?|hsla?|hwb|(ok)?(lab|lch)|color-mix|color|light-dark)\\(.+\\)$/,Ee=/^(inset_)?-?((\\d+)?\\.?(\\d+)[a-z]+|0)_-?((\\d+)?\\.?(\\d+)[a-z]+|0)/,De=/^(url|image|image-set|cross-fade|element|(repeating-)?(linear|radial|conic)-gradient)\\(.+\\)$/,Oe=e=>we.test(e),D=e=>!!e&&!Number.isNaN(Number(e)),O=e=>!!e&&Number.isInteger(Number(e)),k=e=>e.endsWith(`%`)&&D(e.slice(0,-1)),ke=e=>Te.test(e),Ae=()=>!0,je=e=>T.test(e)&&!E.test(e),Me=()=>!1,Ne=e=>Ee.test(e),Pe=e=>De.test(e),Fe=e=>!A(e)&&!j(e),Ie=e=>e.startsWith(`@container`)&&(e[10]===`/`&&e[11]!==void 0||e[11]===`s`&&e[16]!==void 0&&e.startsWith(`-size/`,10)||e[11]===`n`&&e[18]!==void 0&&e.startsWith(`-normal/`,10)),Le=e=>Qe(e,nt,Me),A=e=>Se.test(e),Re=e=>Qe(e,rt,je),ze=e=>Qe(e,it,D),Be=e=>Qe(e,ot,Ae),Ve=e=>Qe(e,at,Me),He=e=>Qe(e,et,Me),Ue=e=>Qe(e,tt,Pe),We=e=>Qe(e,st,Ne),j=e=>Ce.test(e),Ge=e=>$e(e,rt),Ke=e=>$e(e,at),qe=e=>$e(e,et),Je=e=>$e(e,nt),Ye=e=>$e(e,tt),Xe=e=>$e(e,st,!0),Ze=e=>$e(e,ot,!0),Qe=(e,t,n)=>{let r=Se.exec(e);return r?r[1]?t(r[1]):n(r[2]):!1},$e=(e,t,n=!1)=>{let r=Ce.exec(e);return r?r[1]?t(r[1]):n:!1},et=e=>e===`position`||e===`percentage`,tt=e=>e===`image`||e===`url`,nt=e=>e===`length`||e===`size`||e===`bg-size`,rt=e=>e===`length`,it=e=>e===`number`,at=e=>e===`family-name`,ot=e=>e===`number`||e===`weight`,st=e=>e===`shadow`,ct=ye(()=>{let e=xe(`color`),t=xe(`font`),n=xe(`text`),r=xe(`font-weight`),i=xe(`tracking`),a=xe(`leading`),o=xe(`breakpoint`),s=xe(`container`),c=xe(`spacing`),l=xe(`radius`),u=xe(`shadow`),d=xe(`inset-shadow`),f=xe(`text-shadow`),p=xe(`drop-shadow`),m=xe(`blur`),h=xe(`perspective`),g=xe(`aspect`),_=xe(`ease`),v=xe(`animate`),y=()=>[`auto`,`avoid`,`all`,`avoid-page`,`page`,`left`,`right`,`column`],b=()=>[`center`,`top`,`bottom`,`left`,`right`,`top-left`,`left-top`,`top-right`,`right-top`,`bottom-right`,`right-bottom`,`bottom-left`,`left-bottom`],ee=()=>[...b(),j,A],te=()=>[`auto`,`hidden`,`clip`,`visible`,`scroll`],ne=()=>[`auto`,`contain`,`none`],x=()=>[j,A,c],S=()=>[Oe,`full`,`auto`,...x()],re=()=>[O,`none`,`subgrid`,j,A],C=()=>[`auto`,{span:[`full`,O,j,A]},O,j,A],ie=()=>[O,`auto`,j,A],ae=()=>[`auto`,`min`,`max`,`fr`,j,A],oe=()=>[`start`,`end`,`center`,`between`,`around`,`evenly`,`stretch`,`baseline`,`center-safe`,`end-safe`],se=()=>[`start`,`end`,`center`,`stretch`,`center-safe`,`end-safe`],ce=()=>[`auto`,...x()],le=()=>[Oe,`auto`,`full`,`dvw`,`dvh`,`lvw`,`lvh`,`svw`,`svh`,`min`,`max`,`fit`,...x()],ue=()=>[s,Oe,`screen`,`full`,`dvw`,`lvw`,`svw`,`min`,`max`,`fit`,...x()],de=()=>[Oe,`screen`,`full`,`lh`,`dvh`,`lvh`,`svh`,`min`,`max`,`fit`,...x()],w=()=>[e,j,A],fe=()=>[...b(),qe,He,{position:[j,A]}],pe=()=>[`no-repeat`,{repeat:[``,`x`,`y`,`space`,`round`]}],me=()=>[`auto`,`cover`,`contain`,Je,Le,{size:[j,A]}],he=()=>[k,Ge,Re],ge=()=>[``,`none`,`full`,l,j,A],_e=()=>[``,D,Ge,Re],ve=()=>[`solid`,`dashed`,`dotted`,`double`],ye=()=>[`normal`,`multiply`,`screen`,`overlay`,`darken`,`lighten`,`color-dodge`,`color-burn`,`hard-light`,`soft-light`,`difference`,`exclusion`,`hue`,`saturation`,`color`,`luminosity`],be=()=>[D,k,qe,He],Se=()=>[``,`none`,m,j,A],Ce=()=>[`none`,D,j,A],we=()=>[`none`,D,j,A],Te=()=>[D,j,A],T=()=>[Oe,`full`,...x()];return{cacheSize:500,theme:{animate:[`spin`,`ping`,`pulse`,`bounce`],aspect:[`video`],blur:[ke],breakpoint:[ke],color:[Ae],container:[ke],"drop-shadow":[ke],ease:[`in`,`out`,`in-out`],font:[Fe],"font-weight":[`thin`,`extralight`,`light`,`normal`,`medium`,`semibold`,`bold`,`extrabold`,`black`],"inset-shadow":[ke],leading:[`none`,`tight`,`snug`,`normal`,`relaxed`,`loose`],perspective:[`dramatic`,`near`,`normal`,`midrange`,`distant`,`none`],radius:[ke],shadow:[ke],spacing:[`px`,D],text:[ke],"text-shadow":[ke],tracking:[`tighter`,`tight`,`normal`,`wide`,`wider`,`widest`]},classGroups:{aspect:[{aspect:[`auto`,`square`,Oe,A,j,g]}],container:[`container`],"container-type":[{"@container":[``,`normal`,`size`,j,A]}],"container-named":[Ie],columns:[{columns:[D,`auto`,A,j,s]}],"break-after":[{"break-after":y()}],"break-before":[{"break-before":y()}],"break-inside":[{"break-inside":[`auto`,`avoid`,`avoid-page`,`avoid-column`]}],"box-decoration":[{"box-decoration":[`slice`,`clone`]}],box:[{box:[`border`,`content`]}],display:[`block`,`inline-block`,`inline`,`flex`,`inline-flex`,`table`,`inline-table`,`table-caption`,`table-cell`,`table-column`,`table-column-group`,`table-footer-group`,`table-header-group`,`table-row-group`,`table-row`,`flow-root`,`grid`,`inline-grid`,`contents`,`list-item`,`hidden`],sr:[`sr-only`,`not-sr-only`],float:[{float:[`right`,`left`,`none`,`start`,`end`]}],clear:[{clear:[`left`,`right`,`both`,`none`,`start`,`end`]}],isolation:[`isolate`,`isolation-auto`],"object-fit":[{object:[`contain`,`cover`,`fill`,`none`,`scale-down`]}],"object-position":[{object:ee()}],overflow:[{overflow:te()}],"overflow-x":[{"overflow-x":te()}],"overflow-y":[{"overflow-y":te()}],overscroll:[{overscroll:ne()}],"overscroll-x":[{"overscroll-x":ne()}],"overscroll-y":[{"overscroll-y":ne()}],position:[`static`,`fixed`,`absolute`,`relative`,`sticky`],inset:[{inset:S()}],"inset-x":[{"inset-x":S()}],"inset-y":[{"inset-y":S()}],start:[{"inset-s":S(),start:S()}],end:[{"inset-e":S(),end:S()}],"inset-bs":[{"inset-bs":S()}],"inset-be":[{"inset-be":S()}],top:[{top:S()}],right:[{right:S()}],bottom:[{bottom:S()}],left:[{left:S()}],visibility:[`visible`,`invisible`,`collapse`],z:[{z:[O,`auto`,j,A]}],basis:[{basis:[Oe,`full`,`auto`,s,...x()]}],"flex-direction":[{flex:[`row`,`row-reverse`,`col`,`col-reverse`]}],"flex-wrap":[{flex:[`nowrap`,`wrap`,`wrap-reverse`]}],flex:[{flex:[D,Oe,`auto`,`initial`,`none`,A]}],grow:[{grow:[``,D,j,A]}],shrink:[{shrink:[``,D,j,A]}],order:[{order:[O,`first`,`last`,`none`,j,A]}],"grid-cols":[{"grid-cols":re()}],"col-start-end":[{col:C()}],"col-start":[{"col-start":ie()}],"col-end":[{"col-end":ie()}],"grid-rows":[{"grid-rows":re()}],"row-start-end":[{row:C()}],"row-start":[{"row-start":ie()}],"row-end":[{"row-end":ie()}],"grid-flow":[{"grid-flow":[`row`,`col`,`dense`,`row-dense`,`col-dense`]}],"auto-cols":[{"auto-cols":ae()}],"auto-rows":[{"auto-rows":ae()}],gap:[{gap:x()}],"gap-x":[{"gap-x":x()}],"gap-y":[{"gap-y":x()}],"justify-content":[{justify:[...oe(),`normal`]}],"justify-items":[{"justify-items":[...se(),`normal`]}],"justify-self":[{"justify-self":[`auto`,...se()]}],"align-content":[{content:[`normal`,...oe()]}],"align-items":[{items:[...se(),{baseline:[``,`last`]}]}],"align-self":[{self:[`auto`,...se(),{baseline:[``,`last`]}]}],"place-content":[{"place-content":oe()}],"place-items":[{"place-items":[...se(),`baseline`]}],"place-self":[{"place-self":[`auto`,...se()]}],p:[{p:x()}],px:[{px:x()}],py:[{py:x()}],ps:[{ps:x()}],pe:[{pe:x()}],pbs:[{pbs:x()}],pbe:[{pbe:x()}],pt:[{pt:x()}],pr:[{pr:x()}],pb:[{pb:x()}],pl:[{pl:x()}],m:[{m:ce()}],mx:[{mx:ce()}],my:[{my:ce()}],ms:[{ms:ce()}],me:[{me:ce()}],mbs:[{mbs:ce()}],mbe:[{mbe:ce()}],mt:[{mt:ce()}],mr:[{mr:ce()}],mb:[{mb:ce()}],ml:[{ml:ce()}],"space-x":[{"space-x":x()}],"space-x-reverse":[`space-x-reverse`],"space-y":[{"space-y":x()}],"space-y-reverse":[`space-y-reverse`],size:[{size:le()}],"inline-size":[{inline:[`auto`,...ue()]}],"min-inline-size":[{"min-inline":[`auto`,...ue()]}],"max-inline-size":[{"max-inline":[`none`,...ue()]}],"block-size":[{block:[`auto`,...de()]}],"min-block-size":[{"min-block":[`auto`,...de()]}],"max-block-size":[{"max-block":[`none`,...de()]}],w:[{w:[s,`screen`,...le()]}],"min-w":[{"min-w":[s,`screen`,`none`,...le()]}],"max-w":[{"max-w":[s,`screen`,`none`,`prose`,{screen:[o]},...le()]}],h:[{h:[`screen`,`lh`,...le()]}],"min-h":[{"min-h":[`screen`,`lh`,`none`,...le()]}],"max-h":[{"max-h":[`screen`,`lh`,`none`,...le()]}],"font-size":[{text:[`base`,n,Ge,Re]}],"font-smoothing":[`antialiased`,`subpixel-antialiased`],"font-style":[`italic`,`not-italic`],"font-weight":[{font:[r,Ze,Be]}],"font-stretch":[{"font-stretch":[`ultra-condensed`,`extra-condensed`,`condensed`,`semi-condensed`,`normal`,`semi-expanded`,`expanded`,`extra-expanded`,`ultra-expanded`,k,A]}],"font-family":[{font:[Ke,Ve,t]}],"font-features":[{"font-features":[A]}],"fvn-normal":[`normal-nums`],"fvn-ordinal":[`ordinal`],"fvn-slashed-zero":[`slashed-zero`],"fvn-figure":[`lining-nums`,`oldstyle-nums`],"fvn-spacing":[`proportional-nums`,`tabular-nums`],"fvn-fraction":[`diagonal-fractions`,`stacked-fractions`],tracking:[{tracking:[i,j,A]}],"line-clamp":[{"line-clamp":[D,`none`,j,ze]}],leading:[{leading:[`none`,a,...x()]}],"list-image":[{"list-image":[`none`,j,A]}],"list-style-position":[{list:[`inside`,`outside`]}],"list-style-type":[{list:[`disc`,`decimal`,`none`,j,A]}],"text-alignment":[{text:[`left`,`center`,`right`,`justify`,`start`,`end`]}],"placeholder-color":[{placeholder:w()}],"text-color":[{text:w()}],"text-decoration":[`underline`,`overline`,`line-through`,`no-underline`],"text-decoration-style":[{decoration:[...ve(),`wavy`]}],"text-decoration-thickness":[{decoration:[D,`from-font`,`auto`,j,Re]}],"text-decoration-color":[{decoration:w()}],"underline-offset":[{"underline-offset":[D,`auto`,j,A]}],"text-transform":[`uppercase`,`lowercase`,`capitalize`,`normal-case`],"text-overflow":[`truncate`,`text-ellipsis`,`text-clip`],"text-wrap":[{text:[`wrap`,`nowrap`,`balance`,`pretty`]}],indent:[{indent:x()}],"tab-size":[{tab:[O,j,A]}],"vertical-align":[{align:[`baseline`,`top`,`middle`,`bottom`,`text-top`,`text-bottom`,`sub`,`super`,j,A]}],whitespace:[{whitespace:[`normal`,`nowrap`,`pre`,`pre-line`,`pre-wrap`,`break-spaces`]}],break:[{break:[`normal`,`words`,`all`,`keep`]}],wrap:[{wrap:[`break-word`,`anywhere`,`normal`]}],hyphens:[{hyphens:[`none`,`manual`,`auto`]}],content:[{content:[`none`,j,A]}],"bg-attachment":[{bg:[`fixed`,`local`,`scroll`]}],"bg-clip":[{"bg-clip":[`border`,`padding`,`content`,`text`]}],"bg-origin":[{"bg-origin":[`border`,`padding`,`content`]}],"bg-position":[{bg:fe()}],"bg-repeat":[{bg:pe()}],"bg-size":[{bg:me()}],"bg-image":[{bg:[`none`,{linear:[{to:[`t`,`tr`,`r`,`br`,`b`,`bl`,`l`,`tl`]},O,j,A],radial:[``,j,A],conic:[``,O,j,A]},Ye,Ue]}],"bg-color":[{bg:w()}],"gradient-from-pos":[{from:he()}],"gradient-via-pos":[{via:he()}],"gradient-to-pos":[{to:he()}],"gradient-from":[{from:w()}],"gradient-via":[{via:w()}],"gradient-to":[{to:w()}],rounded:[{rounded:ge()}],"rounded-s":[{"rounded-s":ge()}],"rounded-e":[{"rounded-e":ge()}],"rounded-t":[{"rounded-t":ge()}],"rounded-r":[{"rounded-r":ge()}],"rounded-b":[{"rounded-b":ge()}],"rounded-l":[{"rounded-l":ge()}],"rounded-ss":[{"rounded-ss":ge()}],"rounded-se":[{"rounded-se":ge()}],"rounded-ee":[{"rounded-ee":ge()}],"rounded-es":[{"rounded-es":ge()}],"rounded-tl":[{"rounded-tl":ge()}],"rounded-tr":[{"rounded-tr":ge()}],"rounded-br":[{"rounded-br":ge()}],"rounded-bl":[{"rounded-bl":ge()}],"border-w":[{border:_e()}],"border-w-x":[{"border-x":_e()}],"border-w-y":[{"border-y":_e()}],"border-w-s":[{"border-s":_e()}],"border-w-e":[{"border-e":_e()}],"border-w-bs":[{"border-bs":_e()}],"border-w-be":[{"border-be":_e()}],"border-w-t":[{"border-t":_e()}],"border-w-r":[{"border-r":_e()}],"border-w-b":[{"border-b":_e()}],"border-w-l":[{"border-l":_e()}],"divide-x":[{"divide-x":_e()}],"divide-x-reverse":[`divide-x-reverse`],"divide-y":[{"divide-y":_e()}],"divide-y-reverse":[`divide-y-reverse`],"border-style":[{border:[...ve(),`hidden`,`none`]}],"divide-style":[{divide:[...ve(),`hidden`,`none`]}],"border-color":[{border:w()}],"border-color-x":[{"border-x":w()}],"border-color-y":[{"border-y":w()}],"border-color-s":[{"border-s":w()}],"border-color-e":[{"border-e":w()}],"border-color-bs":[{"border-bs":w()}],"border-color-be":[{"border-be":w()}],"border-color-t":[{"border-t":w()}],"border-color-r":[{"border-r":w()}],"border-color-b":[{"border-b":w()}],"border-color-l":[{"border-l":w()}],"divide-color":[{divide:w()}],"outline-style":[{outline:[...ve(),`none`,`hidden`]}],"outline-offset":[{"outline-offset":[D,j,A]}],"outline-w":[{outline:[``,D,Ge,Re]}],"outline-color":[{outline:w()}],shadow:[{shadow:[``,`inner`,`none`,u,Xe,We]}],"shadow-color":[{shadow:w()}],"inset-shadow":[{"inset-shadow":[`none`,d,Xe,We]}],"inset-shadow-color":[{"inset-shadow":w()}],"ring-w":[{ring:_e()}],"ring-w-inset":[`ring-inset`],"ring-color":[{ring:w()}],"ring-offset-w":[{"ring-offset":[D,Re]}],"ring-offset-color":[{"ring-offset":w()}],"inset-ring-w":[{"inset-ring":_e()}],"inset-ring-color":[{"inset-ring":w()}],"text-shadow":[{"text-shadow":[`none`,f,Xe,We]}],"text-shadow-color":[{"text-shadow":w()}],opacity:[{opacity:[D,j,A]}],"mix-blend":[{"mix-blend":[...ye(),`plus-darker`,`plus-lighter`]}],"bg-blend":[{"bg-blend":ye()}],"mask-clip":[{"mask-clip":[`border`,`padding`,`content`,`fill`,`stroke`,`view`]},`mask-no-clip`],"mask-composite":[{mask:[`add`,`subtract`,`intersect`,`exclude`]}],"mask-image-linear-pos":[{"mask-linear":[D]}],"mask-image-linear-from-pos":[{"mask-linear-from":be()}],"mask-image-linear-to-pos":[{"mask-linear-to":be()}],"mask-image-linear-from-color":[{"mask-linear-from":w()}],"mask-image-linear-to-color":[{"mask-linear-to":w()}],"mask-image-t-from-pos":[{"mask-t-from":be()}],"mask-image-t-to-pos":[{"mask-t-to":be()}],"mask-image-t-from-color":[{"mask-t-from":w()}],"mask-image-t-to-color":[{"mask-t-to":w()}],"mask-image-r-from-pos":[{"mask-r-from":be()}],"mask-image-r-to-pos":[{"mask-r-to":be()}],"mask-image-r-from-color":[{"mask-r-from":w()}],"mask-image-r-to-color":[{"mask-r-to":w()}],"mask-image-b-from-pos":[{"mask-b-from":be()}],"mask-image-b-to-pos":[{"mask-b-to":be()}],"mask-image-b-from-color":[{"mask-b-from":w()}],"mask-image-b-to-color":[{"mask-b-to":w()}],"mask-image-l-from-pos":[{"mask-l-from":be()}],"mask-image-l-to-pos":[{"mask-l-to":be()}],"mask-image-l-from-color":[{"mask-l-from":w()}],"mask-image-l-to-color":[{"mask-l-to":w()}],"mask-image-x-from-pos":[{"mask-x-from":be()}],"mask-image-x-to-pos":[{"mask-x-to":be()}],"mask-image-x-from-color":[{"mask-x-from":w()}],"mask-image-x-to-color":[{"mask-x-to":w()}],"mask-image-y-from-pos":[{"mask-y-from":be()}],"mask-image-y-to-pos":[{"mask-y-to":be()}],"mask-image-y-from-color":[{"mask-y-from":w()}],"mask-image-y-to-color":[{"mask-y-to":w()}],"mask-image-radial":[{"mask-radial":[j,A]}],"mask-image-radial-from-pos":[{"mask-radial-from":be()}],"mask-image-radial-to-pos":[{"mask-radial-to":be()}],"mask-image-radial-from-color":[{"mask-radial-from":w()}],"mask-image-radial-to-color":[{"mask-radial-to":w()}],"mask-image-radial-shape":[{"mask-radial":[`circle`,`ellipse`]}],"mask-image-radial-size":[{"mask-radial":[{closest:[`side`,`corner`],farthest:[`side`,`corner`]}]}],"mask-image-radial-pos":[{"mask-radial-at":b()}],"mask-image-conic-pos":[{"mask-conic":[D]}],"mask-image-conic-from-pos":[{"mask-conic-from":be()}],"mask-image-conic-to-pos":[{"mask-conic-to":be()}],"mask-image-conic-from-color":[{"mask-conic-from":w()}],"mask-image-conic-to-color":[{"mask-conic-to":w()}],"mask-mode":[{mask:[`alpha`,`luminance`,`match`]}],"mask-origin":[{"mask-origin":[`border`,`padding`,`content`,`fill`,`stroke`,`view`]}],"mask-position":[{mask:fe()}],"mask-repeat":[{mask:pe()}],"mask-size":[{mask:me()}],"mask-type":[{"mask-type":[`alpha`,`luminance`]}],"mask-image":[{mask:[`none`,j,A]}],filter:[{filter:[``,`none`,j,A]}],blur:[{blur:Se()}],brightness:[{brightness:[D,j,A]}],contrast:[{contrast:[D,j,A]}],"drop-shadow":[{"drop-shadow":[``,`none`,p,Xe,We]}],"drop-shadow-color":[{"drop-shadow":w()}],grayscale:[{grayscale:[``,D,j,A]}],"hue-rotate":[{"hue-rotate":[D,j,A]}],invert:[{invert:[``,D,j,A]}],saturate:[{saturate:[D,j,A]}],sepia:[{sepia:[``,D,j,A]}],"backdrop-filter":[{"backdrop-filter":[``,`none`,j,A]}],"backdrop-blur":[{"backdrop-blur":Se()}],"backdrop-brightness":[{"backdrop-brightness":[D,j,A]}],"backdrop-contrast":[{"backdrop-contrast":[D,j,A]}],"backdrop-grayscale":[{"backdrop-grayscale":[``,D,j,A]}],"backdrop-hue-rotate":[{"backdrop-hue-rotate":[D,j,A]}],"backdrop-invert":[{"backdrop-invert":[``,D,j,A]}],"backdrop-opacity":[{"backdrop-opacity":[D,j,A]}],"backdrop-saturate":[{"backdrop-saturate":[D,j,A]}],"backdrop-sepia":[{"backdrop-sepia":[``,D,j,A]}],"border-collapse":[{border:[`collapse`,`separate`]}],"border-spacing":[{"border-spacing":x()}],"border-spacing-x":[{"border-spacing-x":x()}],"border-spacing-y":[{"border-spacing-y":x()}],"table-layout":[{table:[`auto`,`fixed`]}],caption:[{caption:[`top`,`bottom`]}],transition:[{transition:[``,`all`,`colors`,`opacity`,`shadow`,`transform`,`none`,j,A]}],"transition-behavior":[{transition:[`normal`,`discrete`]}],duration:[{duration:[D,`initial`,j,A]}],ease:[{ease:[`linear`,`initial`,_,j,A]}],delay:[{delay:[D,j,A]}],animate:[{animate:[`none`,v,j,A]}],backface:[{backface:[`hidden`,`visible`]}],perspective:[{perspective:[h,j,A]}],"perspective-origin":[{"perspective-origin":ee()}],rotate:[{rotate:Ce()}],"rotate-x":[{"rotate-x":Ce()}],"rotate-y":[{"rotate-y":Ce()}],"rotate-z":[{"rotate-z":Ce()}],scale:[{scale:we()}],"scale-x":[{"scale-x":we()}],"scale-y":[{"scale-y":we()}],"scale-z":[{"scale-z":we()}],"scale-3d":[`scale-3d`],skew:[{skew:Te()}],"skew-x":[{"skew-x":Te()}],"skew-y":[{"skew-y":Te()}],transform:[{transform:[j,A,``,`none`,`gpu`,`cpu`]}],"transform-origin":[{origin:ee()}],"transform-style":[{transform:[`3d`,`flat`]}],translate:[{translate:T()}],"translate-x":[{"translate-x":T()}],"translate-y":[{"translate-y":T()}],"translate-z":[{"translate-z":T()}],"translate-none":[`translate-none`],zoom:[{zoom:[O,j,A]}],accent:[{accent:w()}],appearance:[{appearance:[`none`,`auto`]}],"caret-color":[{caret:w()}],"color-scheme":[{scheme:[`normal`,`dark`,`light`,`light-dark`,`only-dark`,`only-light`]}],cursor:[{cursor:[`auto`,`default`,`pointer`,`wait`,`text`,`move`,`help`,`not-allowed`,`none`,`context-menu`,`progress`,`cell`,`crosshair`,`vertical-text`,`alias`,`copy`,`no-drop`,`grab`,`grabbing`,`all-scroll`,`col-resize`,`row-resize`,`n-resize`,`e-resize`,`s-resize`,`w-resize`,`ne-resize`,`nw-resize`,`se-resize`,`sw-resize`,`ew-resize`,`ns-resize`,`nesw-resize`,`nwse-resize`,`zoom-in`,`zoom-out`,j,A]}],"field-sizing":[{"field-sizing":[`fixed`,`content`]}],"pointer-events":[{"pointer-events":[`auto`,`none`]}],resize:[{resize:[`none`,``,`y`,`x`]}],"scroll-behavior":[{scroll:[`auto`,`smooth`]}],"scrollbar-thumb-color":[{"scrollbar-thumb":w()}],"scrollbar-track-color":[{"scrollbar-track":w()}],"scrollbar-gutter":[{"scrollbar-gutter":[`auto`,`stable`,`both`]}],"scrollbar-w":[{scrollbar:[`auto`,`thin`,`none`]}],"scroll-m":[{"scroll-m":x()}],"scroll-mx":[{"scroll-mx":x()}],"scroll-my":[{"scroll-my":x()}],"scroll-ms":[{"scroll-ms":x()}],"scroll-me":[{"scroll-me":x()}],"scroll-mbs":[{"scroll-mbs":x()}],"scroll-mbe":[{"scroll-mbe":x()}],"scroll-mt":[{"scroll-mt":x()}],"scroll-mr":[{"scroll-mr":x()}],"scroll-mb":[{"scroll-mb":x()}],"scroll-ml":[{"scroll-ml":x()}],"scroll-p":[{"scroll-p":x()}],"scroll-px":[{"scroll-px":x()}],"scroll-py":[{"scroll-py":x()}],"scroll-ps":[{"scroll-ps":x()}],"scroll-pe":[{"scroll-pe":x()}],"scroll-pbs":[{"scroll-pbs":x()}],"scroll-pbe":[{"scroll-pbe":x()}],"scroll-pt":[{"scroll-pt":x()}],"scroll-pr":[{"scroll-pr":x()}],"scroll-pb":[{"scroll-pb":x()}],"scroll-pl":[{"scroll-pl":x()}],"snap-align":[{snap:[`start`,`end`,`center`,`align-none`]}],"snap-stop":[{snap:[`normal`,`always`]}],"snap-type":[{snap:[`none`,`x`,`y`,`both`]}],"snap-strictness":[{snap:[`mandatory`,`proximity`]}],touch:[{touch:[`auto`,`none`,`manipulation`]}],"touch-x":[{"touch-pan":[`x`,`left`,`right`]}],"touch-y":[{"touch-pan":[`y`,`up`,`down`]}],"touch-pz":[`touch-pinch-zoom`],select:[{select:[`none`,`text`,`all`,`auto`]}],"will-change":[{"will-change":[`auto`,`scroll`,`contents`,`transform`,j,A]}],fill:[{fill:[`none`,...w()]}],"stroke-w":[{stroke:[D,Ge,Re,ze]}],stroke:[{stroke:[`none`,...w()]}],"forced-color-adjust":[{"forced-color-adjust":[`auto`,`none`]}]},conflictingClassGroups:{"container-named":[`container-type`],overflow:[`overflow-x`,`overflow-y`],overscroll:[`overscroll-x`,`overscroll-y`],inset:[`inset-x`,`inset-y`,`inset-bs`,`inset-be`,`start`,`end`,`top`,`right`,`bottom`,`left`],"inset-x":[`start`,`end`,`right`,`left`],"inset-y":[`inset-bs`,`inset-be`,`top`,`bottom`],flex:[`basis`,`grow`,`shrink`],gap:[`gap-x`,`gap-y`],p:[`px`,`py`,`ps`,`pe`,`pbs`,`pbe`,`pt`,`pr`,`pb`,`pl`],px:[`ps`,`pe`,`pr`,`pl`],py:[`pbs`,`pbe`,`pt`,`pb`],m:[`mx`,`my`,`ms`,`me`,`mbs`,`mbe`,`mt`,`mr`,`mb`,`ml`],mx:[`ms`,`me`,`mr`,`ml`],my:[`mbs`,`mbe`,`mt`,`mb`],size:[`w`,`h`],"font-size":[`leading`],"fvn-normal":[`fvn-ordinal`,`fvn-slashed-zero`,`fvn-figure`,`fvn-spacing`,`fvn-fraction`],"fvn-ordinal":[`fvn-normal`],"fvn-slashed-zero":[`fvn-normal`],"fvn-figure":[`fvn-normal`],"fvn-spacing":[`fvn-normal`],"fvn-fraction":[`fvn-normal`],"line-clamp":[`display`,`overflow`],rounded:[`rounded-s`,`rounded-e`,`rounded-t`,`rounded-r`,`rounded-b`,`rounded-l`,`rounded-ss`,`rounded-se`,`rounded-ee`,`rounded-es`,`rounded-tl`,`rounded-tr`,`rounded-br`,`rounded-bl`],"rounded-s":[`rounded-ss`,`rounded-es`],"rounded-e":[`rounded-se`,`rounded-ee`],"rounded-t":[`rounded-tl`,`rounded-tr`],"rounded-r":[`rounded-tr`,`rounded-br`],"rounded-b":[`rounded-br`,`rounded-bl`],"rounded-l":[`rounded-tl`,`rounded-bl`],"border-spacing":[`border-spacing-x`,`border-spacing-y`],"border-w":[`border-w-x`,`border-w-y`,`border-w-s`,`border-w-e`,`border-w-bs`,`border-w-be`,`border-w-t`,`border-w-r`,`border-w-b`,`border-w-l`],"border-w-x":[`border-w-s`,`border-w-e`,`border-w-r`,`border-w-l`],"border-w-y":[`border-w-bs`,`border-w-be`,`border-w-t`,`border-w-b`],"border-color":[`border-color-x`,`border-color-y`,`border-color-s`,`border-color-e`,`border-color-bs`,`border-color-be`,`border-color-t`,`border-color-r`,`border-color-b`,`border-color-l`],"border-color-x":[`border-color-s`,`border-color-e`,`border-color-r`,`border-color-l`],"border-color-y":[`border-color-bs`,`border-color-be`,`border-color-t`,`border-color-b`],translate:[`translate-x`,`translate-y`,`translate-none`],"translate-none":[`translate`,`translate-x`,`translate-y`,`translate-z`],"scroll-m":[`scroll-mx`,`scroll-my`,`scroll-ms`,`scroll-me`,`scroll-mbs`,`scroll-mbe`,`scroll-mt`,`scroll-mr`,`scroll-mb`,`scroll-ml`],"scroll-mx":[`scroll-ms`,`scroll-me`,`scroll-mr`,`scroll-ml`],"scroll-my":[`scroll-mbs`,`scroll-mbe`,`scroll-mt`,`scroll-mb`],"scroll-p":[`scroll-px`,`scroll-py`,`scroll-ps`,`scroll-pe`,`scroll-pbs`,`scroll-pbe`,`scroll-pt`,`scroll-pr`,`scroll-pb`,`scroll-pl`],"scroll-px":[`scroll-ps`,`scroll-pe`,`scroll-pr`,`scroll-pl`],"scroll-py":[`scroll-pbs`,`scroll-pbe`,`scroll-pt`,`scroll-pb`],touch:[`touch-x`,`touch-y`,`touch-pz`],"touch-x":[`touch`],"touch-y":[`touch`],"touch-pz":[`touch`]},conflictingClassGroupModifiers:{"font-size":[`leading`]},postfixLookupClassGroups:[`container-type`],orderSensitiveModifiers:[`*`,`**`,`after`,`backdrop`,`before`,`details-content`,`file`,`first-letter`,`first-line`,`marker`,`placeholder`,`selection`]}});function M(...e){return ct(f(e))}function lt(e){let t=[];for(let n of e){t.push({...n,isStory:!0,story:n.number});for(let e of n.slices)t.push({...e,isStory:!1,story:n.number})}return t}function ut(e){return e.status===`open`?e.states.length===1?e.states[0]:null:e.status}function dt(e){return e.status!==`open`}function ft(e){return e.needsHuman?`bad`:e.states.includes(`needs-human-qa`)||e.holder?.stale?`warn`:dt(e)?`done`:e.states.includes(`blocked`)?`blocked`:e.holder?`live`:`none`}function pt(e){return e.kind===`needs-human`?e.action===`raised`?`bad`:`ok`:e.kind===`claim`?e.action===`stale`?`warn`:`none`:e.kind===`pr`?e.action===`merged`?`ok`:`none`:e.kind===`outcome`?mt(e.outcome)?`warn`:gt(e.step)===`implement`?`none`:`ok`:`none`}function mt(e){return e===`fail`||e===`request-changes`||e===`reject`}function ht(e){return e.kind===`outcome`||e.kind===`needs-human`||e.kind===`pr`&&e.action===`merged`||e.kind===`claim`&&e.action===`stale`}function gt(e){return e===`implementation`||e===`fixing`?`implement`:e===`review`?`review`:e===`agent QA`||e===`human QA`?`qa`:`other`}function _t(e,t){return t?t.isStory?e.filter(e=>e.story===t.number):e.filter(e=>e.issue===t.number):e}function vt(e){return e.filter(e=>!dt(e)&&e.holder?.stale)}function yt(e){return e.filter(e=>!dt(e)&&!e.needsHuman&&e.fixRounds>0&&e.fixRounds===e.maxFixRounds-1)}function bt(e,t){if(e.latestEvidence)return e.latestEvidence;for(let n of t)if(n.issue===e.number&&(n.kind===`qa-evidence`||n.kind===`outcome`&&n.evidence))return n.evidence;return null}var xt=[`ready-for-agent`,`implementation`,`needs-review`,`needs-qa`,`merge-queue`];function St(e){if(dt(e))return xt.length;let t=ut(e);return t===`changes-requested`||t===`qa-failed`?1:t===`needs-human-qa`?3:t?xt.indexOf(t):-1}function Ct(e){return e.slices.filter(e=>e.status===`merged`).length}var wt={branch:(e,t)=>e?`${e}/tree/${t}`:null,commit:(e,t)=>e?`${e}/tree/${t}`:null,file:(e,t,n)=>e?`${e}/blob/${t}/${n.split(`/`).map(encodeURIComponent).join(`/`)}`:null},Tt=(0,l.createContext)(null);function Et(){let e=(0,l.useContext)(Tt);if(!e)throw Error(`useView outside ViewContext`);return e}function Dt(e){throw Error(`no wording for ${JSON.stringify(e)}`)}var Ot=6e4;function kt(e){let t=Math.max(0,Math.round(e/Ot));return t<60?`${Math.max(1,t)}m`:t<1440?`${Math.floor(t/60)}h${t%60?` ${t%60}m`:``}`:`${Math.floor(t/1440)}d`}function At(e,t){let n=t-Date.parse(e);return n<Ot?`just now`:`${kt(n)} ago`}function jt(e){return new Date(e).toLocaleTimeString(`en-GB`,{hour:`2-digit`,minute:`2-digit`})}function Mt(e,t){let n=new Date(e).toDateString();return n===new Date(t).toDateString()?`Today`:n===new Date(t-1440*Ot).toDateString()?`Yesterday`:new Date(e).toLocaleDateString(`en-GB`,{weekday:`long`,day:`numeric`,month:`long`})}function Nt(e,t){return e===null?`a deleted account`:e===t?`you`:`@${e}`}function Pt(e,t){return e.kind===`claim`?`agent ${e.session}`:Nt(e.actor,t)}function Ft(e){return e.charAt(0).toUpperCase()+e.slice(1)}function It(e,t,n){return e===`agent QA`?`Agent QA`:t!==null&&t===n?`Your QA`:`Human QA`}function Lt(e,t){switch(e.step){case`implementation`:return e.fixRound?`Fix round ${e.fixRound} pushed`:`Implementation pushed`;case`fixing`:return e.fixRound?`Story fixes pushed, round ${e.fixRound}`:`Story fixes pushed`;case`review`:if(e.outcome===`approve`)return`Review approved`;if(e.outcome===`request-changes`)return`Review asked for changes`;break;case`agent QA`:case`human QA`:if(e.outcome===`pass`)return`${It(e.step,e.actor,t)} passed`;if(e.outcome===`fail`)return`${It(e.step,e.actor,t)} failed`;break;case`merge`:return`Merged into the story branch`;case`resolving needs-human`:return`Escalation resolved`;case`triage`:if(e.outcome===`accept`)return`Accepted at triage`;if(e.outcome===`reject`)return`Rejected at triage`;break;case`refinement`:if(e.outcome===`clear`)return`Refined, no open questions`;if(e.outcome===`questions`)return`Refinement raised questions`;break;case`clarification`:if(e.outcome===`answered`)return`Questions answered`;if(e.outcome===`questions`)return`Questions remain after clarification`;break;case`planning`:return`Plan written`;case`slicing`:return`Sliced`}return e.outcome===`done`?`${Ft(e.step)} done`:`${Ft(e.step)}: ${e.outcome}`}function Rt(e){return e.detail===`IssueComment`?`commented`:e.detail===`LabeledEvent`&&e.label?`labelled ${e.label}`:e.detail===`UnlabeledEvent`&&e.label?`removed label ${e.label}`:`other activity: ${e.detail}${e.label?` (${e.label})`:``}`}function zt(e){switch(e.kind){case`step`:return`${e.from??`no state`} \u2192 ${e.to}`;case`outcome`:return`${e.step}: ${e.outcome}${e.fixRound?`, fix round ${e.fixRound}/${e.maxFixRounds}`:``}`;case`needs-human`:return e.action===`raised`?`needs-human raised${e.reason?`: ${e.reason}`:``}`:`needs-human resolved`;case`qa-evidence`:return`QA evidence pushed to ${e.evidence.branch} (${Ut(e.evidence.files.length)})`;case`slice`:return e.action===`created`?`slice created`:`slice unblocked`;case`pr`:return`${e.target} PR #${e.pr} ${e.action}`;case`claim`:return e.action===`taken`?`claim taken`:e.action===`released`?`claim released`:`claim went stale`;case`other-activity`:return Rt(e);default:return Dt(e)}}function Bt(e,t){switch(e.kind){case`outcome`:return Lt(e,t);case`needs-human`:return e.action===`raised`?`Escalated to you`:`Escalation resolved`;case`pr`:return e.action===`merged`?`${e.target===`story`?`Story`:`Slice`} PR #${e.pr} merged`:zt(e);case`claim`:return e.action===`stale`?`Agent ${e.session} went quiet`:zt(e);case`step`:case`qa-evidence`:case`slice`:case`other-activity`:return zt(e);default:return Dt(e)}}function Vt(e){return e.kind!==`outcome`||!e.fixRound||e.step===`implementation`||e.step===`fixing`?null:`round ${e.fixRound} of ${e.maxFixRounds}`}function Ht(e){return e.kind===`needs-human`&&e.action===`raised`?e.reason:null}function Ut(e){return e===1?`1 file`:`${e} files`}function Wt(e,t){return`on ${e??`#${t}`}`}function Gt(e){return`${e} routine updates`}function Kt(e){switch(e){case`needs-refinement`:return`Waiting for refinement`;case`needs-clarification`:return`Waiting for answers to its open questions`;case`needs-plan`:return`Waiting for a plan`;case`needs-slicing`:return`Waiting to be sliced`;case`blocked`:return`Blocked`;case`ready-for-agent`:return`Ready for an agent`;case`implementation`:return`Being implemented`;case`needs-review`:return`Waiting for review`;case`changes-requested`:return`Back for fixes after review`;case`needs-qa`:return`Waiting for agent QA`;case`needs-human-qa`:return`Waiting for your QA`;case`qa-failed`:return`Back for fixes after QA`;case`merge-queue`:return`Queued to merge`;default:return Dt(e)}}function qt(e){let t=ut(e);return t===`merged`?`Merged`:t===`closed`?`Closed without merging`:t===null?e.states.length?`Its state labels disagree: ${e.states.join(` and `)}`:`Has no norn state label`:Kt(t)}function Jt(e,t,n){let r=e.login===t?`Agent ${e.session}`:`${Nt(e.login,t)}\'s agent ${e.session}`,i=kt(n-Date.parse(e.since));return e.stale?`${r} went quiet ${i} ago.`:`${r} on it for ${i}.`}function Yt(e,t){return`agent ${e.session} quiet for ${kt(t-Date.parse(e.since))}`}function Xt(e,t){return e?`${e} of ${t} fix rounds used`:`No fix rounds yet`}function Zt(e,t){return t?`${e} of ${t} slices merged`:`Not sliced yet`}function N(e,t){return t?`${e} of ${t}`:`no slices`}function Qt(e){return e.needsHuman?{text:`needs you`,tone:`bad`}:e.states.includes(`needs-human-qa`)?{text:`your QA`,tone:`warn`}:e.holder?.stale?{text:`quiet`,tone:`warn`}:null}var $t={overview:`Overview`,yourStories:`Your stories`,noStories:`No open stories of yours.`,closedThisWeek:`Closed this week`},en={story:`Story`,sliceOf:`Slice of`,waitsFor:`Waits for`,and:`and`,humanQa:`You QA this one before it merges`,labels:`Labels on GitHub`,latestEvidence:`Latest QA evidence`,openOnGitHub:`Open on GitHub \u2197`,progress:`Progress`,noStories:`Nothing in progress.`,pipeline:[`build`,`review`,`QA`,`merge`]},P={everything:`Everything`,remarks:`Remarks`,all:`All`,implement:`Implement`,review:`Review`,qa:`QA`,github:`GitHub \u2197`,showWhole:`Show the whole remark`,showLess:`Show less`,hide:`hide`,overview:`Overview`,loading:`Loading history\u2026`,refreshing:`Refreshing`,theme:`Switch between light and dark`};function tn(e){switch(e.kind){case`needs-human`:return`Escalated`;case`needs-human-qa`:return`Your QA`;default:return Dt(e.kind)}}function nn(e){switch(e.kind){case`needs-human`:return`Escalated to you`;case`needs-human-qa`:return`Waiting for your QA`;default:return Dt(e.kind)}}function rn(e){switch(e.kind){case`needs-human`:return e.reason??`Someone flagged it needs-human by hand; its comments say why.`;case`needs-human-qa`:return e.issue===e.story?`Every slice merged and agent QA passed. Your QA closes the story.`:`Agent QA passed. A few checks need a person.`;default:return Dt(e.kind)}}var an=[`Nothing`,`One thing`,`Two things`,`Three things`,`Four things`,`Five things`];function on(e){return`${an[e]??`${e} things`} ${e<=1?`needs`:`need`} you${e?``:` right now`}`}function sn(e,t){return`${e===0?`No agents are working`:e===1?`1 agent is working`:`${e} agents are working`}${t?`, ${t} went quiet`:``}.`}function cn(e,t){let n=t?` Showing data from ${jt(t)}.`:``;return`${ln(e.reason,e.detail)}${n}`}function ln(e,t){switch(e){case`auth`:return`GitHub didn\'t accept norn\'s credentials: run gh auth login, then refresh.`;case`rate-limit`:return`Hit GitHub\'s rate limit; norn tries again at the next poll.`;case`network`:return`Can\'t reach GitHub; norn tries again at the next poll.`;case`other`:return`Reading GitHub failed: ${t}`;default:return Dt(e)}}var un=`Can\'t reach the dashboard server. Is norn dashboard still running?`;function dn(e,t){return e?`Updated ${At(e,t)}`:`Not updated yet`}function fn(e){return`norn reads GitHub every ${kt(e)}; click to read now`}function pn(e){return e?`History`:`What happened`}function mn(e){return e?`No remarks here.`:`Nothing here yet.`}var hn=e((e=>{var t=Symbol.for(`react.transitional.element`),n=Symbol.for(`react.fragment`);function r(e,n,r){var i=null;if(r!==void 0&&(i=``+r),n.key!==void 0&&(i=``+n.key),`key`in n)for(var a in r={},n)a!==`key`&&(r[a]=n[a]);else r=n;return n=r.ref,{$$typeof:t,type:e,key:i,ref:n===void 0?null:n,props:r}}e.Fragment=n,e.jsx=r,e.jsxs=r})),F=e(((e,t)=>{t.exports=hn()}))();function gn({command:e}){let[t,n]=(0,l.useState)(!1),r=async()=>{try{await navigator.clipboard.writeText(e),n(!0),setTimeout(()=>n(!1),1500)}catch{}};return(0,F.jsxs)(`span`,{onClick:e=>e.stopPropagation(),className:`inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-0.5 font-mono text-[12.5px] text-soft`,children:[e,(0,F.jsx)(`button`,{type:`button`,onClick:()=>void r(),className:`border-0 bg-transparent p-0 font-sans text-[12px] text-faint hover:text-foreground`,children:t?`copied`:`copy`})]})}var _n=e=>typeof e==`boolean`?`${e}`:e===0?`0`:e,vn=f,yn=(e,t)=>n=>{if(t?.variants==null)return vn(e,n?.class,n?.className);let{variants:r,defaultVariants:i}=t,a=Object.keys(r).map(e=>{let t=n?.[e],a=i?.[e];if(t===null)return null;let o=_n(t)||_n(a);return r[e][o]}),o=n&&Object.entries(n).reduce((e,t)=>{let[n,r]=t;return r===void 0||(e[n]=r),e},{});return vn(e,a,t?.compoundVariants?.reduce((e,t)=>{let{class:n,className:r,...a}=t;return Object.entries(a).every(e=>{let[t,n]=e;return Array.isArray(n)?n.includes({...i,...o}[t]):{...i,...o}[t]===n})?[...e,n,r]:e},[]),n?.class,n?.className)},bn=yn(`inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px font-mono text-[11.5px] leading-[1.6]`,{variants:{tone:{neutral:`border-border bg-muted text-muted-foreground`,warn:`border-transparent bg-warn-bg text-warn`,bad:`border-transparent bg-bad-bg text-bad`}},defaultVariants:{tone:`neutral`}});function xn({className:e,tone:t,...n}){return(0,F.jsx)(`span`,{className:M(bn({tone:t}),e),...n})}function Sn({href:e,className:t,title:n,children:r}){return e?(0,F.jsx)(`a`,{href:e,target:`_blank`,rel:`noreferrer`,className:t,title:n,children:r}):(0,F.jsx)(`span`,{className:t,title:n,children:r})}function Cn({evidence:e,compact:t=!1}){let{state:n}=Et(),r=n.repoUrl,i=(0,F.jsxs)(F.Fragment,{children:[(0,F.jsxs)(Sn,{href:wt.branch(r,e.branch),className:`font-mono text-[12.5px] text-ok`,title:`the branch with every QA run\'s evidence for this issue`,children:[`\u2442 `,e.branch]}),(0,F.jsxs)(Sn,{href:wt.commit(r,e.sha),className:`font-mono text-[12.5px] text-muted-foreground`,title:`the commit this QA run pushed`,children:[`@`,e.sha.slice(0,7)]}),(0,F.jsx)(`span`,{className:`text-[13px] text-muted-foreground`,children:Ut(e.files.length)})]});return t?(0,F.jsx)(`div`,{className:`mt-2 inline-flex flex-wrap items-center gap-2.5 rounded-[10px] border border-border bg-card px-2.5 py-1`,children:i}):(0,F.jsxs)(`div`,{className:`mt-3 overflow-hidden rounded-[10px] border border-border bg-card`,children:[(0,F.jsx)(`div`,{className:`flex flex-wrap items-center gap-2.5 px-3 py-2 text-[13px]`,children:i}),e.files.length>0&&(0,F.jsx)(`div`,{className:`flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 pb-2.5 font-mono text-[12.5px]`,children:e.files.map(t=>(0,F.jsx)(Sn,{href:wt.file(r,e.sha,t),className:`text-muted-foreground hover:text-foreground`,children:t},t))})]})}var wn=`text-[13px] text-faint`,Tn=e=>e===`needs-human`?`bad`:e===`needs-human-qa`?`warn`:`neutral`,En=`border-0 bg-transparent p-0 text-left text-inherit hover:underline hover:underline-offset-3`;function Dn({used:e,max:t}){return(0,F.jsx)(`span`,{className:`inline-flex gap-[3px] align-middle`,role:`img`,"aria-label":Xt(e,t),children:Array.from({length:t},(n,r)=>(0,F.jsx)(`i`,{className:M(`h-1 w-3.5 rounded-sm bg-border`,r<e&&(e>=t?`bg-bad`:`bg-warn`))},r))})}function On({x:e}){let{state:t,item:n,now:r,select:i}=Et(),a=t.board.find(t=>t.number===e.story),o=t.waiting.find(t=>t.issue===e.number),s=bt(e,t.feed),c=St(e),u=e.states.includes(`blocked`);return(0,F.jsxs)(`div`,{children:[(0,F.jsx)(`div`,{className:wn,children:e.isStory?en.story:(0,F.jsxs)(F.Fragment,{children:[en.sliceOf,` `,(0,F.jsx)(`button`,{type:`button`,className:M(En,`text-muted-foreground`),onClick:()=>i(e.story),children:a?.title??`#${e.story}`})]})}),(0,F.jsx)(`h3`,{className:`mt-1 mb-1.5 font-semibold text-[18px] leading-[1.35] tracking-[-0.01em]`,children:e.title}),e.labels.length>0&&(0,F.jsx)(`div`,{className:`mb-2.5 flex flex-wrap gap-1`,title:en.labels,children:e.labels.map(e=>(0,F.jsx)(xn,{tone:Tn(e),children:e},e))}),(0,F.jsxs)(`p`,{className:`mt-0 mb-[18px] text-soft`,children:[qt(e),`.`,e.holder&&!dt(e)&&` ${Jt(e.holder,t.me,r)}`]}),o&&(0,F.jsxs)(`div`,{className:`mb-[22px] rounded-xl bg-warn-bg px-4 py-3.5`,children:[(0,F.jsx)(`b`,{className:`mb-0.5 block font-medium text-[14px] text-warn`,children:nn(o)}),(0,F.jsx)(`p`,{className:`mt-0 mb-2.5 text-[14px] text-soft`,children:rn(o)}),(0,F.jsx)(gn,{command:o.command})]}),!e.isStory&&!u&&(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`div`,{className:`mb-1.5 flex gap-[3px]`,children:xt.map((e,t)=>(0,F.jsx)(`span`,{className:M(`h-1 flex-1 rounded-sm bg-border`,t<c&&`bg-ok`,t===c&&`bg-live`)},e))}),(0,F.jsx)(`div`,{className:`mb-[22px] flex justify-between text-[11.5px] text-faint`,children:en.pipeline.map(e=>(0,F.jsx)(`span`,{children:e},e))})]}),(0,F.jsxs)(`ul`,{className:`m-0 mb-[22px] list-none p-0 [&>li]:flex [&>li]:flex-wrap [&>li]:items-center [&>li]:gap-2.5 [&>li]:border-border [&>li]:border-t [&>li]:py-[9px] [&>li]:text-[14px] [&>li]:text-soft [&>li:last-child]:border-b`,children:[e.blockedBy.length>0&&(0,F.jsx)(`li`,{children:(0,F.jsxs)(`span`,{children:[en.waitsFor,` `,e.blockedBy.map((e,t)=>(0,F.jsxs)(l.Fragment,{children:[t>0&&` ${en.and} `,(0,F.jsx)(`button`,{type:`button`,className:En,onClick:()=>i(e),children:n(e)?.title??`#${e}`})]},e))]})}),(!e.isStory||e.fixRounds>0)&&(0,F.jsxs)(`li`,{children:[(0,F.jsx)(Dn,{used:e.fixRounds,max:e.maxFixRounds}),` `,Xt(e.fixRounds,e.maxFixRounds)]}),e.humanQa&&!dt(e)&&(0,F.jsx)(`li`,{children:en.humanQa}),e.isStory&&a&&(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`li`,{children:Zt(Ct(a),a.slices.length)}),(0,F.jsx)(`li`,{children:(0,F.jsx)(`span`,{className:`font-mono text-[12.5px] text-muted-foreground`,children:a.branch})})]})]}),s&&(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`div`,{className:M(wn,`-mb-1`),children:en.latestEvidence}),(0,F.jsx)(Cn,{evidence:s})]}),(0,F.jsx)(`p`,{className:`mt-[22px]`,children:(0,F.jsx)(`a`,{className:`text-[13px] text-muted-foreground`,href:e.url,target:`_blank`,rel:`noreferrer`,children:en.openOnGitHub})})]})}function kn(){let{state:e,select:t}=Et(),n=e.board.filter(e=>!dt(e));return(0,F.jsxs)(`div`,{children:[(0,F.jsx)(`div`,{className:M(wn,`mb-4`),children:en.progress}),n.length===0&&(0,F.jsx)(`p`,{className:`text-[14px] text-muted-foreground`,children:en.noStories}),n.map(e=>{let n=Ct(e);return(0,F.jsxs)(`button`,{type:`button`,onClick:()=>t(e.number),className:`mb-[18px] block w-full border-0 bg-transparent p-0 text-left`,children:[(0,F.jsxs)(`span`,{className:`flex justify-between gap-2.5 text-[14px]`,children:[(0,F.jsx)(`span`,{children:e.title}),(0,F.jsx)(`span`,{className:`whitespace-nowrap text-[13px] text-faint`,children:N(n,e.slices.length)})]}),(0,F.jsx)(`span`,{className:`mt-1.5 block h-1 overflow-hidden rounded-sm bg-border`,children:(0,F.jsx)(`i`,{className:`block h-full rounded-sm bg-ok`,style:{width:`${e.slices.length?n/e.slices.length*100:0}%`}})})]},e.number)})]})}var An=/(`[^`]+`)|(\\*\\*[^*]+\\*\\*)|(!?\\[([^\\]]*)\\]\\(([^)\\s]+)\\))/g;function jn(e){return/^https?:\\/\\//i.test(e)?e:null}function Mn(e){let t=[],n=0;for(let r of e.matchAll(An)){let i=r.index??0;i>n&&t.push(e.slice(n,i));let a=t.length;if(r[1])t.push((0,F.jsx)(`code`,{className:`rounded-[5px] bg-muted px-[5px] py-px font-mono text-[12.5px]`,children:r[1].slice(1,-1)},a));else if(r[2])t.push((0,F.jsx)(`b`,{className:`font-semibold text-foreground`,children:r[2].slice(2,-2)},a));else{let e=r[4]||r[5],n=jn(r[5]);t.push(n?(0,F.jsx)(`a`,{href:n,target:`_blank`,rel:`noreferrer`,className:`underline underline-offset-3`,children:e},a):e)}n=i+r[0].length}return n<e.length&&t.push(e.slice(n)),t}function Nn(e){let t=[],n=e=>t.push({...e,key:t.length}),r=[],i=null,a=()=>{r.length&&n({kind:`p`,text:r.join(` `)}),r=[]},o=e=>{let i=t[t.length-1];return i&&i.kind===e&&r.length===0?i:(a(),n({kind:e,items:[]}),t[t.length-1])},s=!1;for(let c of e.replace(/\\r\\n/g,`\n`).split(`\n`)){if(i){c.trimStart().startsWith("```")?(n({kind:`pre`,text:i.join(`\n`)}),i=null):i.push(c);continue}if(c.trimStart().startsWith("```")){a(),s=!1,i=[];continue}let e=c.match(/^#{1,6} (.*)/);if(e){a(),s=!1,n({kind:`h`,text:e[1]});continue}let l=c.match(/^\\s*[-*] \\[( |x|X)\\] (.*)/),u=c.match(/^\\s*[-*] (.*)/),d=c.match(/^\\s*\\d+[.)] (.*)/);if(l||u||d){let e=o(d&&!l&&!u?`ol`:`ul`),t=e.items.length;l?e.items.push({key:t,text:l[2],check:l[1]!==` `}):e.items.push({key:t,text:(u??d)[1],check:null}),s=!0;continue}if(!c.trim()){a(),s=!1;continue}let f=t[t.length-1];if(s&&f&&(f.kind===`ul`||f.kind===`ol`)){let e=f.items[f.items.length-1];e.text=`${e.text} ${c.trim()}`}else r.push(c.trim())}return i&&n({kind:`pre`,text:i.join(`\n`)}),a(),t}function Pn({source:e}){return(0,F.jsx)(`div`,{className:`text-[14px] leading-[1.65] text-soft [&>:last-child]:mb-0`,children:Nn(e).map(e=>{switch(e.kind){case`p`:return(0,F.jsx)(`p`,{className:`mt-0 mb-2`,children:Mn(e.text)},e.key);case`h`:return(0,F.jsx)(`h4`,{className:`mt-2.5 mb-1 font-semibold text-[13px] text-foreground`,children:Mn(e.text)},e.key);case`pre`:return(0,F.jsx)(`pre`,{className:`mt-1.5 mb-2.5 overflow-x-auto rounded-[10px] bg-background/60 px-3 py-2.5 font-mono text-[12.5px]`,children:e.text},e.key);case`ul`:case`ol`:{let t=e.kind;return(0,F.jsx)(t,{className:e.kind===`ul`?`mt-0.5 mb-2 list-disc pl-5`:`mt-0.5 mb-2 list-decimal pl-5`,children:e.items.map(e=>(0,F.jsxs)(`li`,{className:e.check===null?`my-[3px]`:`my-[3px] -ml-5 list-none`,children:[e.check!==null&&(0,F.jsx)(`span`,{role:`img`,"aria-label":e.check?`checked`:`not checked`,className:e.check?`mr-1.5 text-ok`:`mr-1.5 text-faint`,children:e.check?`\u2611`:`\u2610`}),Mn(e.text)]},e.key))},e.key)}default:return e}})})}function Fn({value:e,options:t,onChange:n,label:r}){return(0,F.jsx)(`fieldset`,{"aria-label":r,className:`m-0 inline-flex min-w-0 gap-0.5 rounded-[10px] border-0 bg-muted p-[3px]`,children:t.map(t=>(0,F.jsx)(`button`,{type:`button`,"aria-pressed":t.value===e,onClick:()=>n(t.value),className:M(`rounded-lg border-0 bg-transparent px-3 py-0.5 text-[13px] text-muted-foreground`,t.value===e&&`bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]`),children:t.label},t.value))})}var In={bad:`bg-bad`,warn:`bg-warn`,ok:`bg-ok`,none:`bg-border`};function Ln(){let{state:e,selected:t}=Et(),[n,r]=(0,l.useState)(`everything`),[i,a]=(0,l.useState)(`all`),o=_t(e.feed,t),s=n===`remarks`?o.filter(e=>e.kind===`outcome`&&e.note&&(i===`all`||gt(e.step)===i)):o;return(0,F.jsxs)(`div`,{children:[(0,F.jsxs)(`div`,{className:`mb-1.5 flex flex-wrap items-center gap-3`,children:[(0,F.jsx)(`h3`,{className:`m-0 flex-1 font-medium text-[13px] text-faint`,children:pn(t!==null)}),n===`remarks`&&(0,F.jsx)(Fn,{label:`Remarks of`,value:i,onChange:a,options:[{value:`all`,label:P.all},{value:`implement`,label:P.implement},{value:`review`,label:P.review},{value:`qa`,label:P.qa}]}),(0,F.jsx)(Fn,{label:`Show`,value:n,onChange:r,options:[{value:`everything`,label:P.everything},{value:`remarks`,label:P.remarks}]})]}),(0,F.jsx)(Rn,{feed:s,empty:mn(n===`remarks`)})]})}function Rn({feed:e,empty:t}){let{now:n}=Et();if(e.length===0)return(0,F.jsx)(`p`,{className:`text-muted-foreground`,children:t});let r=[];for(let t of e){let e=Mt(t.at,n),i=r[r.length-1];(!i||i.label!==e)&&(i={label:e,chunks:[]},r.push(i));let a=i.chunks[i.chunks.length-1];ht(t)?i.chunks.push({routine:!1,event:t}):a?.routine?a.events.push(t):i.chunks.push({routine:!0,events:[t]})}return r.map(e=>(0,F.jsxs)(`div`,{children:[(0,F.jsx)(`div`,{className:`mt-[26px] mb-2 text-[13px] text-faint`,children:e.label}),e.chunks.map(e=>e.routine?(0,F.jsx)(Wn,{events:e.events},`r${e.events[0].id}`):(0,F.jsx)(Hn,{e:e.event},e.event.id))]},e.label))}var zn=`grid grid-cols-[52px_1fr] gap-x-3.5`,Bn=`pt-px text-[13px] text-faint tabular-nums`;function Vn({e}){let{item:t,selected:n}=Et();return n?.number===e.issue?null:(0,F.jsxs)(`span`,{className:`text-muted-foreground`,children:[` `,Wt(t(e.issue)?.title,e.issue)]})}function Hn({e}){let{state:t}=Et(),n=Vt(e),r=Ht(e);return(0,F.jsxs)(`div`,{className:M(zn,`py-2.5`),children:[(0,F.jsx)(`span`,{className:Bn,children:jt(e.at)}),(0,F.jsxs)(`div`,{className:`min-w-0`,children:[(0,F.jsxs)(`div`,{className:`text-foreground`,children:[(0,F.jsx)(`span`,{className:M(`mr-2 inline-block size-[7px] rounded-full align-[1px]`,In[pt(e)])}),Bt(e,t.me),n&&(0,F.jsxs)(`span`,{className:`text-muted-foreground`,children:[` \xB7 `,n]}),(0,F.jsx)(Vn,{e})]}),r&&(0,F.jsx)(`div`,{className:`text-[14px] text-soft`,children:r}),(0,F.jsxs)(`div`,{className:`mt-px text-[13px] text-faint`,children:[Pt(e,t.me),` \xB7`,` `,(0,F.jsx)(`a`,{href:e.url,target:`_blank`,rel:`noreferrer`,className:`text-faint hover:text-foreground`,children:P.github})]}),e.kind===`outcome`&&e.note&&(0,F.jsx)(Un,{note:e.note,evidence:e.evidence,tone:pt(e)}),e.kind===`outcome`&&!e.note&&e.evidence&&(0,F.jsx)(Cn,{evidence:e.evidence,compact:!0})]})]})}function Un({note:e,evidence:t,tone:n}){let[r,i]=(0,l.useState)(!1),[a,o]=(0,l.useState)(!0),s=(0,l.useRef)(null);return(0,l.useLayoutEffect)(()=>{let e=s.current;e&&!r&&o(e.scrollHeight>e.clientHeight+1)},[r]),(0,F.jsxs)(`div`,{className:M(`mt-2.5 rounded-xl bg-muted px-4 py-3`,(n===`warn`||n===`bad`)&&`shadow-[inset_3px_0_0_var(--warn)]`),children:[(0,F.jsx)(`div`,{ref:s,className:r||!a?void 0:`clamp`,children:(0,F.jsx)(Pn,{source:e})}),(a||r)&&(0,F.jsx)(`button`,{type:`button`,onClick:()=>i(!r),className:`mt-1.5 border-0 bg-transparent p-0 text-[13px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-3`,children:r?P.showLess:P.showWhole}),t&&(0,F.jsx)(`div`,{children:(0,F.jsx)(Cn,{evidence:t,compact:!r})})]})}function Wn({events:e}){let{state:t}=Et(),[n,r]=(0,l.useState)(!1),i=e[0],a=`border-0 bg-transparent p-0 text-left text-[13px] text-faint hover:text-foreground`;return n?e.map((e,n)=>(0,F.jsxs)(`div`,{className:M(zn,`py-[3px]`),children:[(0,F.jsx)(`span`,{className:Bn,children:jt(e.at)}),(0,F.jsxs)(`div`,{className:`min-w-0 text-[13.5px] text-muted-foreground`,children:[zt(e),(0,F.jsx)(Vn,{e}),` `,(0,F.jsxs)(`span`,{className:`text-faint`,children:[`\xB7 `,Pt(e,t.me),` \xB7 `]}),(0,F.jsx)(`a`,{href:e.url,target:`_blank`,rel:`noreferrer`,className:`text-faint hover:text-foreground`,children:P.github}),n===0&&(0,F.jsxs)(F.Fragment,{children:[` `,(0,F.jsx)(`button`,{type:`button`,className:a,onClick:()=>r(!1),children:P.hide})]}),e.kind===`qa-evidence`&&(0,F.jsx)(`div`,{children:(0,F.jsx)(Cn,{evidence:e.evidence,compact:!0})})]})]},e.id)):(0,F.jsxs)(`div`,{className:M(zn,`py-[3px]`),children:[(0,F.jsx)(`span`,{className:Bn,children:jt(i.at)}),(0,F.jsx)(`div`,{children:(0,F.jsxs)(`button`,{type:`button`,className:a,onClick:()=>r(!0),children:[e.length===1?(0,F.jsxs)(F.Fragment,{children:[zt(i),(0,F.jsx)(Vn,{e:i})]}):Gt(e.length),` `,(0,F.jsx)(`span`,{"aria-hidden":!0,children:`\u203A`})]})})]})}function Gn({className:e,height:t}){return(0,F.jsx)(`div`,{className:M(`my-2.5 animate-shimmer rounded-[10px] bg-[linear-gradient(90deg,var(--muted),var(--border),var(--muted))] bg-size-[200%_100%]`,e),style:{height:t}})}function Kn({count:e,height:t}){return Array.from({length:e},(e,n)=>(0,F.jsx)(Gn,{height:t},n))}var qn={bad:`bg-bad`,warn:`bg-warn`,done:`border-[1.5px] border-ok bg-transparent`,blocked:`border-[1.5px] border-dashed border-faint bg-transparent`,live:`bg-live shadow-[0_0_0_3px_var(--live-bg)]`,none:`bg-border`};function Jn({dot:e,className:t}){return(0,F.jsx)(`span`,{className:M(`size-[7px] flex-none rounded-full`,qn[e],t)})}function Yn({x:e}){let t=Qt(e);return t?(0,F.jsx)(`span`,{className:M(`whitespace-nowrap text-[12px]`,t.tone===`bad`?`text-bad`:`text-warn`),children:t.text}):null}function Xn({n:e,kind:t,children:n}){let{selected:r,select:i}=Et(),a=(r?.number??null)===e;return(0,F.jsx)(`button`,{type:`button`,onClick:()=>i(e),"aria-current":a?`true`:void 0,className:M(`flex w-full items-center gap-2.5 rounded-lg border-0 bg-transparent px-2.5 py-[5px] text-left text-[14px] text-soft hover:bg-muted`,t===`story`&&`mt-1.5 font-medium text-foreground`,t===`child`&&`pl-3.5 text-[13.5px] text-muted-foreground`,a&&`bg-muted font-medium text-foreground`),children:n})}var Zn=`flex-1 truncate`;function Qn({loading:e}){let{state:t}=Et(),n=t.board.filter(e=>!dt(e)),r=t.board.filter(e=>dt(e)),i=t.waiting.length;return(0,F.jsxs)(`nav`,{"aria-label":`Stories`,children:[(0,F.jsxs)(`div`,{className:`flex items-center gap-2.5 px-2.5 pb-[18px]`,children:[(0,F.jsx)(`img`,{src:`/favicon.svg`,alt:``,width:64,height:64,className:`flex-none rounded-[16px]`}),(0,F.jsxs)(`div`,{className:`flex min-w-0 flex-col`,children:[(0,F.jsx)(`b`,{className:`text-[15px] tracking-[-0.01em]`,children:`norn`}),(0,F.jsx)(`span`,{className:`truncate text-[12px] text-faint`,children:t.repoUrl?.replace(/^https?:\\/\\/(www\\.)?github\\.com\\//,``)??``})]})]}),(0,F.jsxs)(Xn,{n:null,kind:`top`,children:[(0,F.jsx)(`span`,{className:Zn,children:$t.overview}),i>0&&(0,F.jsx)(`span`,{className:`rounded-full bg-warn-bg px-[7px] font-medium text-[12px] text-warn`,children:i})]}),e?(0,F.jsx)(Kn,{count:8,height:22}):(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`div`,{className:`px-2.5 pt-[18px] pb-1.5 text-[12px] text-faint`,children:$t.yourStories}),n.length===0&&(0,F.jsx)(`p`,{className:`px-2.5 text-[13px] text-muted-foreground`,children:$t.noStories}),n.map(e=>(0,F.jsxs)(`div`,{children:[(0,F.jsxs)(Xn,{n:e.number,kind:`story`,children:[(0,F.jsx)(`span`,{className:Zn,children:e.title}),(0,F.jsx)(Yn,{x:e})]}),e.slices.map(e=>(0,F.jsxs)(Xn,{n:e.number,kind:`child`,children:[(0,F.jsx)(Jn,{dot:ft(e)}),(0,F.jsx)(`span`,{className:Zn,children:e.title}),(0,F.jsx)(Yn,{x:e})]},e.number))]},e.number)),r.length>0&&(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`div`,{className:`px-2.5 pt-[18px] pb-1.5 text-[12px] text-faint`,children:$t.closedThisWeek}),r.map(e=>(0,F.jsxs)(Xn,{n:e.number,kind:`child`,children:[(0,F.jsx)(Jn,{dot:`done`}),(0,F.jsx)(`span`,{className:Zn,children:e.title})]},e.number))]})]})]})}function $n(){let{state:e,items:t,now:n,select:r}=Et(),i=t.filter(e=>!dt(e)).filter(e=>e.holder&&!e.holder.stale).length,a=vt(t),o=yt(t);return(0,F.jsxs)(`div`,{children:[(0,F.jsx)(`h1`,{className:`mt-0 mb-1.5 font-semibold text-[26px] leading-[1.25] tracking-[-0.02em]`,children:on(e.waiting.length)}),(0,F.jsx)(`p`,{className:`mt-0 mb-[22px] text-muted-foreground`,children:sn(i,a.length)}),e.waiting.map(e=>{let t=e.kind===`needs-human`;return(0,F.jsxs)(`div`,{role:`button`,tabIndex:0,onClick:()=>r(e.issue),onKeyDown:t=>{(t.key===`Enter`||t.key===` `)&&(t.preventDefault(),r(e.issue))},className:`mb-2.5 grid cursor-pointer grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 rounded-[14px] border border-border bg-card px-[18px] py-4 transition-[border-color,box-shadow] hover:border-faint hover:shadow-[0_2px_10px_rgba(0,0,0,.04)]`,children:[(0,F.jsx)(`div`,{className:`font-medium text-[15.5px]`,children:e.title}),(0,F.jsx)(`div`,{className:`col-start-1 text-[14px] text-muted-foreground`,children:rn(e)}),(0,F.jsxs)(`div`,{className:`col-start-2 row-span-2 row-start-1 flex flex-col items-end gap-1.5`,children:[(0,F.jsxs)(`span`,{className:M(`font-medium text-[12.5px]`,t?`text-bad`:`text-warn`),children:[tn(e),e.since&&` \xB7 ${At(e.since,n)}`]}),(0,F.jsx)(gn,{command:e.command})]})]},e.issue)}),(a.length>0||o.length>0)&&(0,F.jsxs)(`div`,{className:`mt-[26px]`,children:[(0,F.jsx)(`h3`,{className:`mt-0 mb-2.5 font-medium text-[13px] text-faint`,children:`Worth a look`}),a.map(e=>(0,F.jsx)(er,{n:e.number,title:e.title,note:Yt(e.holder,n),dot:`warn`},`q${e.number}`)),o.map(e=>(0,F.jsx)(er,{n:e.number,title:e.title,note:Xt(e.fixRounds,e.maxFixRounds),dot:`faint`},`f${e.number}`))]})]})}function er({n:e,title:t,note:n,dot:r}){let{select:i}=Et();return(0,F.jsxs)(`button`,{type:`button`,onClick:()=>i(e),className:`group flex w-full items-baseline gap-2.5 border-0 bg-transparent px-0 py-1.5 text-left text-[14px] text-soft`,children:[(0,F.jsx)(Jn,{dot:r===`warn`?`warn`:`none`,className:M(`self-center`,r===`faint`&&`bg-faint`)}),(0,F.jsx)(`span`,{className:`group-hover:underline group-hover:underline-offset-3`,children:t}),(0,F.jsx)(`span`,{className:`text-[13px] text-faint`,children:n})]})}var tr=yn(`inline-flex items-center gap-1.5 whitespace-nowrap border-0 bg-transparent font-[inherit] transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60`,{variants:{variant:{quiet:`rounded-lg px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground`,link:`p-0 text-[13px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-3`,faint:`p-0 text-[13px] text-faint hover:text-foreground`}},defaultVariants:{variant:`quiet`}});function nr({className:e,variant:t,type:n=`button`,...r}){return(0,F.jsx)(`button`,{type:n,className:M(tr({variant:t}),e),...r})}function rr(){return(0,F.jsx)(`span`,{className:`inline-block size-3 animate-spin rounded-full border-2 border-border border-t-muted-foreground align-[-1px]`})}async function ir(e){if(!e.ok)throw Error(`${e.status} ${e.statusText}`);return await e.json()}async function ar(){return ir(await fetch(`/api/state`,{cache:`no-store`}))}async function or(){return ir(await fetch(`/api/refresh`,{method:`POST`}))}var sr=`norn-dashboard-theme`;function cr(){return window.matchMedia(`(prefers-color-scheme: dark)`).matches?`dark`:`light`}function lr(){try{let e=window.localStorage.getItem(sr);if(e===`light`||e===`dark`)return{theme:e,chosen:!0}}catch{}return{theme:cr(),chosen:!1}}function ur(e){let t=document.documentElement;t.classList.toggle(`dark`,e===`dark`),t.classList.toggle(`light`,e===`light`)}function dr(e){try{window.localStorage.setItem(sr,e)}catch{}}var fr=1e4,pr=15e3,mr={status:`loading`,me:null,repoUrl:null,board:[],waiting:[],feed:[],lastUpdated:null,lastError:null,intervalMs:12e4,nextPoll:null,now:new Date().toISOString()};function hr(){let[e,t]=(0,l.useState)(mr),[n,r]=(0,l.useState)(0),[i,a]=(0,l.useState)(!1),[o,s]=(0,l.useState)(!1),c=(0,l.useRef)(!1),u=(0,l.useCallback)(e=>{t(e),r(Date.parse(e.now)-Date.now()),a(!1)},[]),d=(0,l.useCallback)(async()=>{if(!c.current){c.current=!0;try{u(await ar())}catch{a(!0)}finally{c.current=!1}}},[u]),f=(0,l.useCallback)(async()=>{s(!0);try{u(await or())}catch{a(!0)}finally{s(!1)}},[u]);return(0,l.useEffect)(()=>{d();let e=setInterval(()=>void d(),fr);return()=>clearInterval(e)},[d]),{state:e,offset:n,serverGone:i,refreshing:o,refresh:f}}function gr(e){let[,t]=(0,l.useState)(0);return(0,l.useEffect)(()=>{let e=setInterval(()=>t(e=>e+1),pr);return()=>clearInterval(e)},[]),Date.now()+e}function _r(){let[e,t]=(0,l.useState)(()=>lr().theme);return(0,l.useEffect)(()=>{let e=lr();ur(e.chosen?e.theme:null)},[]),()=>{let n=e===`dark`?`light`:`dark`;t(n),ur(n),dr(n)}}function vr(){let{state:e,offset:t,serverGone:n,refreshing:r,refresh:i}=hr(),a=gr(t),o=_r(),[s,c]=(0,l.useState)(null),u=(0,l.useMemo)(()=>lt(e.board),[e.board]),d=(0,l.useMemo)(()=>new Map(u.map(e=>[e.number,e])),[u]),f=s===null?null:d.get(s)??null,p=(0,l.useCallback)(e=>c(t=>e===null||t===e?null:e),[]),m={state:e,items:u,item:e=>d.get(e),now:a,selected:f,select:p},h=e.status===`loading`,g=n?un:e.lastError?cn(e.lastError,e.lastUpdated):null,_=r||e.status===`ready`&&e.nextPoll===null;return(0,F.jsx)(Tt.Provider,{value:m,children:(0,F.jsxs)(`div`,{className:`grid grid-cols-1 min-[1000px]:h-screen min-[1000px]:grid-cols-[264px_1fr_340px]`,children:[(0,F.jsx)(`aside`,{className:`px-3 pt-5 pb-6 min-[1000px]:overflow-y-auto min-[1000px]:border-border min-[1000px]:border-r min-[1000px]:pb-24`,children:(0,F.jsx)(Qn,{loading:h})}),(0,F.jsx)(`main`,{className:`px-4 pt-5 pb-16 min-[1000px]:overflow-y-auto min-[1000px]:px-10 min-[1000px]:pt-7 min-[1000px]:pb-28`,children:(0,F.jsxs)(`div`,{className:`mx-auto max-w-[720px]`,children:[(0,F.jsxs)(`div`,{className:`mb-7 flex min-h-[30px] items-center gap-1.5`,children:[(0,F.jsx)(`span`,{className:`flex-1 text-[13px] text-faint`,children:f&&(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`button`,{type:`button`,className:`border-0 bg-transparent p-0 text-muted-foreground hover:underline hover:underline-offset-3`,onClick:()=>p(null),children:P.overview}),` `,`/ #`,f.number]})}),h&&!e.lastError?(0,F.jsxs)(`span`,{className:`text-[13px] text-muted-foreground`,children:[(0,F.jsx)(rr,{}),` `,P.loading]}):(0,F.jsx)(nr,{onClick:()=>void i(),disabled:r,title:fn(e.intervalMs),children:_?(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(rr,{}),` `,P.refreshing]}):(0,F.jsxs)(F.Fragment,{children:[dn(e.lastUpdated,a),` \u21BB`]})}),(0,F.jsx)(nr,{onClick:o,title:P.theme,"aria-label":P.theme,children:`\u25D0`})]}),g&&(0,F.jsx)(`p`,{role:`status`,className:`-mt-1 mb-5 text-[13px] text-warn`,children:g}),h?(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(Gn,{height:34}),(0,F.jsx)(Kn,{count:3,height:76}),(0,F.jsx)(Kn,{count:6,height:40})]}):(0,F.jsxs)(`div`,{className:M(g&&`opacity-55`),children:[f?(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)(`h1`,{className:`mt-0 mb-1 font-semibold text-[24px] leading-[1.3] tracking-[-0.02em]`,children:f.title}),(0,F.jsx)(`p`,{className:`mt-0 mb-7 text-muted-foreground`,children:qt(f)})]}):(0,F.jsxs)(F.Fragment,{children:[(0,F.jsx)($n,{}),(0,F.jsx)(`div`,{className:`mt-10 mb-7 h-px bg-border`})]}),(0,F.jsx)(Ln,{})]})]})}),(0,F.jsx)(`section`,{"aria-label":`Details`,className:M(`border-border border-t bg-card px-4 pt-7 pb-16 min-[1000px]:overflow-y-auto min-[1000px]:border-t-0 min-[1000px]:border-l min-[1000px]:px-6 min-[1000px]:pb-28`,!h&&g&&`[&>*]:opacity-55`),children:h?(0,F.jsx)(Kn,{count:6,height:30}):f?(0,F.jsx)(On,{x:f},f.number):(0,F.jsx)(kn,{})})]})})}var yr=document.getElementById(`root`);if(!yr)throw Error(`the page has no #root element`);(0,u.createRoot)(yr).render((0,F.jsx)(l.StrictMode,{children:(0,F.jsx)(vr,{})}));', css: '/*! tailwindcss v4.3.3 | MIT License | https://tailwindcss.com */\n@layer properties{@supports (((-webkit-hyphens:none)) and (not (margin-trim:inline))) or ((-moz-orient:inline) and (not (color:rgb(from red r g b)))){*,:before,:after,::backdrop{--tw-border-style:solid;--tw-leading:initial;--tw-font-weight:initial;--tw-tracking:initial;--tw-ordinal:initial;--tw-slashed-zero:initial;--tw-numeric-figure:initial;--tw-numeric-spacing:initial;--tw-numeric-fraction:initial;--tw-shadow:0 0 #0000;--tw-shadow-color:initial;--tw-shadow-alpha:100%;--tw-inset-shadow:0 0 #0000;--tw-inset-shadow-color:initial;--tw-inset-shadow-alpha:100%;--tw-ring-color:initial;--tw-ring-shadow:0 0 #0000;--tw-inset-ring-color:initial;--tw-inset-ring-shadow:0 0 #0000;--tw-ring-inset:initial;--tw-ring-offset-width:0px;--tw-ring-offset-color:#fff;--tw-ring-offset-shadow:0 0 #0000;--tw-blur:initial;--tw-brightness:initial;--tw-contrast:initial;--tw-grayscale:initial;--tw-hue-rotate:initial;--tw-invert:initial;--tw-opacity:initial;--tw-saturate:initial;--tw-sepia:initial;--tw-drop-shadow:initial;--tw-drop-shadow-color:initial;--tw-drop-shadow-alpha:100%;--tw-drop-shadow-size:initial;--tw-outline-style:solid}}}@layer theme{:root,:host{--font-sans:ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;--spacing:.25rem;--font-weight-medium:500;--font-weight-semibold:600;--animate-spin:spin 1s linear infinite;--default-transition-duration:.15s;--default-transition-timing-function:cubic-bezier(.4, 0, .2, 1);--default-font-family:ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;--default-mono-font-family:ui-monospace, SFMono-Regular, Menlo, monospace}}@layer base{*,:after,:before,::backdrop{box-sizing:border-box;border:0 solid;margin:0;padding:0}::file-selector-button{box-sizing:border-box;border:0 solid;margin:0;padding:0}html,:host{-webkit-text-size-adjust:100%;tab-size:4;line-height:1.5;font-family:var(--default-font-family,-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", "Noto Sans", Arial, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji");font-feature-settings:var(--default-font-feature-settings,normal);font-variation-settings:var(--default-font-variation-settings,normal);-webkit-tap-highlight-color:transparent}hr{height:0;color:inherit;border-top-width:1px}abbr:where([title]){-webkit-text-decoration:underline dotted;text-decoration:underline dotted}h1,h2,h3,h4,h5,h6{font-size:inherit;font-weight:inherit}a{color:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;-webkit-text-decoration:inherit;text-decoration:inherit}b,strong{font-weight:bolder}code,kbd,samp,pre{font-family:var(--default-mono-font-family,ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace);font-feature-settings:var(--default-mono-font-feature-settings,normal);font-variation-settings:var(--default-mono-font-variation-settings,normal);font-size:1em}small{font-size:80%}sub,sup{vertical-align:baseline;font-size:75%;line-height:0;position:relative}sub{bottom:-.25em}sup{top:-.5em}table{text-indent:0;border-color:inherit;border-collapse:collapse}:-moz-focusring:where(:not(iframe)){outline:auto}progress{vertical-align:baseline}summary{display:list-item}ol,ul,menu{list-style:none}img,svg,video,canvas,audio,iframe,embed,object{vertical-align:middle;display:block}img,video{max-width:100%;height:auto}button,input,select,optgroup,textarea{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}::file-selector-button{font:inherit;font-feature-settings:inherit;font-variation-settings:inherit;letter-spacing:inherit;color:inherit;opacity:1;background-color:#0000;border-radius:0}:where(select:is([multiple],[size])) optgroup{font-weight:bolder}:where(select:is([multiple],[size])) optgroup option{padding-inline-start:20px}::file-selector-button{margin-inline-end:4px}::placeholder{opacity:1}@supports (not ((-webkit-appearance:-apple-pay-button))) or (contain-intrinsic-size:1px){::placeholder{color:currentColor}@supports (color:color-mix(in lab, red, red)){::placeholder{color:color-mix(in oklab, currentcolor 50%, transparent)}}}textarea{resize:vertical}::-webkit-search-decoration{-webkit-appearance:none}::-webkit-date-and-time-value{min-height:1lh;text-align:inherit}::-webkit-datetime-edit{display:inline-flex}::-webkit-datetime-edit-fields-wrapper{padding:0}::-webkit-datetime-edit{padding-block:0}::-webkit-datetime-edit-year-field{padding-block:0}::-webkit-datetime-edit-month-field{padding-block:0}::-webkit-datetime-edit-day-field{padding-block:0}::-webkit-datetime-edit-hour-field{padding-block:0}::-webkit-datetime-edit-minute-field{padding-block:0}::-webkit-datetime-edit-second-field{padding-block:0}::-webkit-datetime-edit-millisecond-field{padding-block:0}::-webkit-datetime-edit-meridiem-field{padding-block:0}::-webkit-calendar-picker-indicator{line-height:1}:-moz-ui-invalid{box-shadow:none}button,input:where([type=button],[type=reset],[type=submit]){appearance:button}::file-selector-button{appearance:button}::-webkit-inner-spin-button{height:auto}::-webkit-outer-spin-button{height:auto}[hidden]:where(:not([hidden=until-found])){display:none!important}*{border-color:var(--border)}html,body{background:var(--background);color:var(--foreground);font:15px / 1.6 var(--font-sans);-webkit-font-smoothing:antialiased;margin:0}a:hover{text-underline-offset:3px;text-decoration:underline}button{cursor:pointer}}@layer components;@layer utilities{.visible{visibility:visible}.fixed{position:fixed}.col-start-1{grid-column-start:1}.col-start-2{grid-column-start:2}.row-span-2{grid-row:span 2/span 2}.row-start-1{grid-row-start:1}.m-0{margin:0}.mx-auto{margin-inline:auto}.my-2\\.5{margin-block:calc(var(--spacing) * 2.5)}.my-\\[3px\\]{margin-block:3px}.-mt-1{margin-top:calc(var(--spacing) * -1)}.mt-0{margin-top:0}.mt-0\\.5{margin-top:calc(var(--spacing) * .5)}.mt-1{margin-top:var(--spacing)}.mt-1\\.5{margin-top:calc(var(--spacing) * 1.5)}.mt-2{margin-top:calc(var(--spacing) * 2)}.mt-2\\.5{margin-top:calc(var(--spacing) * 2.5)}.mt-3{margin-top:calc(var(--spacing) * 3)}.mt-10{margin-top:calc(var(--spacing) * 10)}.mt-\\[22px\\]{margin-top:22px}.mt-\\[26px\\]{margin-top:26px}.mt-px{margin-top:1px}.mr-1\\.5{margin-right:calc(var(--spacing) * 1.5)}.mr-2{margin-right:calc(var(--spacing) * 2)}.-mb-1{margin-bottom:calc(var(--spacing) * -1)}.mb-0\\.5{margin-bottom:calc(var(--spacing) * .5)}.mb-1{margin-bottom:var(--spacing)}.mb-1\\.5{margin-bottom:calc(var(--spacing) * 1.5)}.mb-2{margin-bottom:calc(var(--spacing) * 2)}.mb-2\\.5{margin-bottom:calc(var(--spacing) * 2.5)}.mb-4{margin-bottom:calc(var(--spacing) * 4)}.mb-5{margin-bottom:calc(var(--spacing) * 5)}.mb-7{margin-bottom:calc(var(--spacing) * 7)}.mb-\\[18px\\]{margin-bottom:18px}.mb-\\[22px\\]{margin-bottom:22px}.-ml-5{margin-left:calc(var(--spacing) * -5)}.block{display:block}.flex{display:flex}.grid{display:grid}.inline-block{display:inline-block}.inline-flex{display:inline-flex}.size-3{width:calc(var(--spacing) * 3);height:calc(var(--spacing) * 3)}.size-\\[7px\\]{width:7px;height:7px}.h-1{height:var(--spacing)}.h-full{height:100%}.h-px{height:1px}.min-h-\\[30px\\]{min-height:30px}.w-3\\.5{width:calc(var(--spacing) * 3.5)}.w-full{width:100%}.max-w-\\[720px\\]{max-width:720px}.min-w-0{min-width:0}.flex-1{flex:1}.flex-none{flex:none}.animate-shimmer{animation:1.4s linear infinite shimmer}.animate-spin{animation:var(--animate-spin)}.cursor-pointer{cursor:pointer}.list-decimal{list-style-type:decimal}.list-disc{list-style-type:disc}.list-none{list-style-type:none}.grid-cols-1{grid-template-columns:repeat(1,minmax(0,1fr))}.grid-cols-\\[1fr_auto\\]{grid-template-columns:1fr auto}.grid-cols-\\[52px_1fr\\]{grid-template-columns:52px 1fr}.flex-col{flex-direction:column}.flex-wrap{flex-wrap:wrap}.items-baseline{align-items:baseline}.items-center{align-items:center}.items-end{align-items:flex-end}.justify-between{justify-content:space-between}.gap-0\\.5{gap:calc(var(--spacing) * .5)}.gap-1{gap:var(--spacing)}.gap-1\\.5{gap:calc(var(--spacing) * 1.5)}.gap-2{gap:calc(var(--spacing) * 2)}.gap-2\\.5{gap:calc(var(--spacing) * 2.5)}.gap-3{gap:calc(var(--spacing) * 3)}.gap-\\[3px\\]{gap:3px}.gap-x-3\\.5{column-gap:calc(var(--spacing) * 3.5)}.gap-x-4{column-gap:calc(var(--spacing) * 4)}.gap-y-1{row-gap:var(--spacing)}.self-center{align-self:center}.truncate{text-overflow:ellipsis;white-space:nowrap;overflow:hidden}.overflow-hidden{overflow:hidden}.overflow-x-auto{overflow-x:auto}.rounded-\\[5px\\]{border-radius:5px}.rounded-\\[10px\\]{border-radius:10px}.rounded-\\[14px\\]{border-radius:14px}.rounded-\\[16px\\]{border-radius:16px}.rounded-full{border-radius:2147483647px}.rounded-lg{border-radius:var(--radius)}.rounded-md{border-radius:calc(var(--radius) - 2px)}.rounded-sm{border-radius:calc(var(--radius) - 4px)}.rounded-xl{border-radius:calc(var(--radius) + 4px)}.border{border-style:var(--tw-border-style);border-width:1px}.border-0{border-style:var(--tw-border-style);border-width:0}.border-2{border-style:var(--tw-border-style);border-width:2px}.border-\\[1\\.5px\\]{border-style:var(--tw-border-style);border-width:1.5px}.border-t{border-top-style:var(--tw-border-style);border-top-width:1px}.border-dashed{--tw-border-style:dashed;border-style:dashed}.border-border{border-color:var(--border)}.border-faint{border-color:var(--faint)}.border-ok{border-color:var(--ok)}.border-transparent{border-color:#0000}.border-t-muted-foreground{border-top-color:var(--muted-foreground)}.bg-background\\/60{background-color:var(--background)}@supports (color:color-mix(in lab, red, red)){.bg-background\\/60{background-color:color-mix(in oklab, var(--background) 60%, transparent)}}.bg-bad{background-color:var(--bad)}.bg-bad-bg{background-color:var(--bad-bg)}.bg-border{background-color:var(--border)}.bg-card{background-color:var(--card)}.bg-faint{background-color:var(--faint)}.bg-live{background-color:var(--live)}.bg-muted{background-color:var(--muted)}.bg-ok{background-color:var(--ok)}.bg-transparent{background-color:#0000}.bg-warn{background-color:var(--warn)}.bg-warn-bg{background-color:var(--warn-bg)}.bg-\\[linear-gradient\\(90deg\\,var\\(--muted\\)\\,var\\(--border\\)\\,var\\(--muted\\)\\)\\]{background-image:linear-gradient(90deg,var(--muted),var(--border),var(--muted))}.bg-size-\\[200\\%_100\\%\\]{background-size:200% 100%}.p-0{padding:0}.p-\\[3px\\]{padding:3px}.px-0{padding-inline:0}.px-1\\.5{padding-inline:calc(var(--spacing) * 1.5)}.px-2{padding-inline:calc(var(--spacing) * 2)}.px-2\\.5{padding-inline:calc(var(--spacing) * 2.5)}.px-3{padding-inline:calc(var(--spacing) * 3)}.px-4{padding-inline:calc(var(--spacing) * 4)}.px-\\[5px\\]{padding-inline:5px}.px-\\[7px\\]{padding-inline:7px}.px-\\[18px\\]{padding-inline:18px}.py-0\\.5{padding-block:calc(var(--spacing) * .5)}.py-1{padding-block:var(--spacing)}.py-1\\.5{padding-block:calc(var(--spacing) * 1.5)}.py-2{padding-block:calc(var(--spacing) * 2)}.py-2\\.5{padding-block:calc(var(--spacing) * 2.5)}.py-3{padding-block:calc(var(--spacing) * 3)}.py-3\\.5{padding-block:calc(var(--spacing) * 3.5)}.py-4{padding-block:calc(var(--spacing) * 4)}.py-\\[3px\\]{padding-block:3px}.py-\\[5px\\]{padding-block:5px}.py-px{padding-block:1px}.pt-1{padding-top:var(--spacing)}.pt-5{padding-top:calc(var(--spacing) * 5)}.pt-7{padding-top:calc(var(--spacing) * 7)}.pt-\\[18px\\]{padding-top:18px}.pt-px{padding-top:1px}.pb-1\\.5{padding-bottom:calc(var(--spacing) * 1.5)}.pb-2\\.5{padding-bottom:calc(var(--spacing) * 2.5)}.pb-6{padding-bottom:calc(var(--spacing) * 6)}.pb-16{padding-bottom:calc(var(--spacing) * 16)}.pb-\\[18px\\]{padding-bottom:18px}.pl-3\\.5{padding-left:calc(var(--spacing) * 3.5)}.pl-5{padding-left:calc(var(--spacing) * 5)}.text-left{text-align:left}.align-\\[-1px\\]{vertical-align:-1px}.align-\\[1px\\]{vertical-align:1px}.align-middle{vertical-align:middle}.font-\\[inherit\\]{font-family:inherit}.font-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}.font-sans{font-family:ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif}.text-\\[11\\.5px\\]{font-size:11.5px}.text-\\[12\\.5px\\]{font-size:12.5px}.text-\\[12px\\]{font-size:12px}.text-\\[13\\.5px\\]{font-size:13.5px}.text-\\[13px\\]{font-size:13px}.text-\\[14px\\]{font-size:14px}.text-\\[15\\.5px\\]{font-size:15.5px}.text-\\[15px\\]{font-size:15px}.text-\\[18px\\]{font-size:18px}.text-\\[24px\\]{font-size:24px}.text-\\[26px\\]{font-size:26px}.leading-\\[1\\.3\\]{--tw-leading:1.3;line-height:1.3}.leading-\\[1\\.6\\]{--tw-leading:1.6;line-height:1.6}.leading-\\[1\\.25\\]{--tw-leading:1.25;line-height:1.25}.leading-\\[1\\.35\\]{--tw-leading:1.35;line-height:1.35}.leading-\\[1\\.65\\]{--tw-leading:1.65;line-height:1.65}.font-medium{--tw-font-weight:var(--font-weight-medium);font-weight:var(--font-weight-medium)}.font-semibold{--tw-font-weight:var(--font-weight-semibold);font-weight:var(--font-weight-semibold)}.tracking-\\[-0\\.01em\\]{--tw-tracking:-.01em;letter-spacing:-.01em}.tracking-\\[-0\\.02em\\]{--tw-tracking:-.02em;letter-spacing:-.02em}.whitespace-nowrap{white-space:nowrap}.text-bad{color:var(--bad)}.text-faint{color:var(--faint)}.text-foreground{color:var(--foreground)}.text-inherit{color:inherit}.text-muted-foreground{color:var(--muted-foreground)}.text-ok{color:var(--ok)}.text-soft{color:var(--soft)}.text-warn{color:var(--warn)}.tabular-nums{--tw-numeric-spacing:tabular-nums;font-variant-numeric:var(--tw-ordinal,) var(--tw-slashed-zero,) var(--tw-numeric-figure,) var(--tw-numeric-spacing,) var(--tw-numeric-fraction,)}.underline{text-decoration-line:underline}.underline-offset-3{text-underline-offset:3px}.opacity-55{opacity:.55}.shadow-\\[0_0_0_3px_var\\(--live-bg\\)\\]{--tw-shadow:0 0 0 3px var(--tw-shadow-color,var(--live-bg));box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.shadow-\\[0_1px_2px_rgba\\(0\\,0\\,0\\,\\.06\\)\\]{--tw-shadow:0 1px 2px var(--tw-shadow-color,#0000000f);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.shadow-\\[inset_3px_0_0_var\\(--warn\\)\\]{--tw-shadow:inset 3px 0 0 var(--tw-shadow-color,var(--warn));box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}.filter{filter:var(--tw-blur,) var(--tw-brightness,) var(--tw-contrast,) var(--tw-grayscale,) var(--tw-hue-rotate,) var(--tw-invert,) var(--tw-saturate,) var(--tw-sepia,) var(--tw-drop-shadow,)}.transition-\\[border-color\\,box-shadow\\]{transition-property:border-color,box-shadow;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}.transition-colors{transition-property:color,background-color,border-color,outline-color,text-decoration-color,fill,stroke,--tw-gradient-from,--tw-gradient-via,--tw-gradient-to;transition-timing-function:var(--tw-ease,var(--default-transition-timing-function));transition-duration:var(--tw-duration,var(--default-transition-duration))}@media (hover:hover){.group-hover\\:underline:is(:where(.group):hover *){text-decoration-line:underline}.group-hover\\:underline-offset-3:is(:where(.group):hover *){text-underline-offset:3px}.hover\\:border-faint:hover{border-color:var(--faint)}.hover\\:bg-muted:hover{background-color:var(--muted)}.hover\\:text-foreground:hover{color:var(--foreground)}.hover\\:underline:hover{text-decoration-line:underline}.hover\\:underline-offset-3:hover{text-underline-offset:3px}.hover\\:shadow-\\[0_2px_10px_rgba\\(0\\,0\\,0\\,\\.04\\)\\]:hover{--tw-shadow:0 2px 10px var(--tw-shadow-color,#0000000a);box-shadow:var(--tw-inset-shadow), var(--tw-inset-ring-shadow), var(--tw-ring-offset-shadow), var(--tw-ring-shadow), var(--tw-shadow)}}.focus-visible\\:outline-2:focus-visible{outline-style:var(--tw-outline-style);outline-width:2px}.focus-visible\\:outline-ring:focus-visible{outline-color:var(--ring)}.disabled\\:pointer-events-none:disabled{pointer-events:none}.disabled\\:opacity-60:disabled{opacity:.6}@media (width>=1000px){.min-\\[1000px\\]\\:h-screen{height:100vh}.min-\\[1000px\\]\\:grid-cols-\\[264px_1fr_340px\\]{grid-template-columns:264px 1fr 340px}.min-\\[1000px\\]\\:overflow-y-auto{overflow-y:auto}.min-\\[1000px\\]\\:border-t-0{border-top-style:var(--tw-border-style);border-top-width:0}.min-\\[1000px\\]\\:border-r{border-right-style:var(--tw-border-style);border-right-width:1px}.min-\\[1000px\\]\\:border-l{border-left-style:var(--tw-border-style);border-left-width:1px}.min-\\[1000px\\]\\:border-border{border-color:var(--border)}.min-\\[1000px\\]\\:px-6{padding-inline:calc(var(--spacing) * 6)}.min-\\[1000px\\]\\:px-10{padding-inline:calc(var(--spacing) * 10)}.min-\\[1000px\\]\\:pt-7{padding-top:calc(var(--spacing) * 7)}.min-\\[1000px\\]\\:pb-24{padding-bottom:calc(var(--spacing) * 24)}.min-\\[1000px\\]\\:pb-28{padding-bottom:calc(var(--spacing) * 28)}}.\\[\\&\\>\\*\\]\\:opacity-55>*{opacity:.55}.\\[\\&\\>\\:last-child\\]\\:mb-0>:last-child{margin-bottom:0}.\\[\\&\\>li\\]\\:flex>li{display:flex}.\\[\\&\\>li\\]\\:flex-wrap>li{flex-wrap:wrap}.\\[\\&\\>li\\]\\:items-center>li{align-items:center}.\\[\\&\\>li\\]\\:gap-2\\.5>li{gap:calc(var(--spacing) * 2.5)}.\\[\\&\\>li\\]\\:border-t>li{border-top-style:var(--tw-border-style);border-top-width:1px}.\\[\\&\\>li\\]\\:border-border>li{border-color:var(--border)}.\\[\\&\\>li\\]\\:py-\\[9px\\]>li{padding-block:9px}.\\[\\&\\>li\\]\\:text-\\[14px\\]>li{font-size:14px}.\\[\\&\\>li\\]\\:text-soft>li{color:var(--soft)}.\\[\\&\\>li\\:last-child\\]\\:border-b>li:last-child{border-bottom-style:var(--tw-border-style);border-bottom-width:1px}}:root{--background:#faf8f3;--foreground:#14182e;--card:#fff;--card-foreground:#14182e;--primary:#14182e;--primary-foreground:#f3dca6;--secondary:#f2eee4;--secondary-foreground:#14182e;--muted:#f2eee4;--muted-foreground:#5e6382;--accent:#f2eee4;--accent-foreground:#14182e;--border:#e7e1d3;--input:#e7e1d3;--ring:#c8862a;--radius:.75rem;--soft:#2e3350;--faint:#9a9cb2;--live:#a8730f;--live-bg:#f8edd2;--ok:#2f7a4f;--warn:#c2571a;--warn-bg:#fbeee3;--bad:#b8322a;--bad-bg:#fbeae7;--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light}.dark{--background:#0e1122;--foreground:#f1ede4;--card:#14182e;--card-foreground:#f1ede4;--primary:#e8b44a;--primary-foreground:#14182e;--secondary:#1c2140;--secondary-foreground:#f1ede4;--muted:#1c2140;--muted-foreground:#a3a7c2;--accent:#1c2140;--accent-foreground:#f1ede4;--border:#262c4e;--input:#262c4e;--ring:#c8862a;--soft:#ddd8cc;--faint:#626a91;--live:#e8b44a;--live-bg:#33291a;--ok:#7fcf9a;--warn:#ef9257;--warn-bg:#33221a;--bad:#f26b5b;--bad-bg:#361c1d;--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark}@media (prefers-color-scheme:dark){:root:not(.light){--background:#0e1122;--foreground:#f1ede4;--card:#14182e;--card-foreground:#f1ede4;--primary:#e8b44a;--primary-foreground:#14182e;--secondary:#1c2140;--secondary-foreground:#f1ede4;--muted:#1c2140;--muted-foreground:#a3a7c2;--accent:#1c2140;--accent-foreground:#f1ede4;--border:#262c4e;--input:#262c4e;--ring:#c8862a;--soft:#ddd8cc;--faint:#626a91;--live:#e8b44a;--live-bg:#33291a;--ok:#7fcf9a;--warn:#ef9257;--warn-bg:#33221a;--bad:#f26b5b;--bad-bg:#361c1d;--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark}}.clamp{max-height:5.2em;position:relative;overflow:hidden}.clamp:after{content:"";background:linear-gradient(transparent, var(--muted));height:2em;position:absolute;inset:auto 0 0}@property --tw-border-style{syntax:"*";inherits:false;initial-value:solid}@property --tw-leading{syntax:"*";inherits:false}@property --tw-font-weight{syntax:"*";inherits:false}@property --tw-tracking{syntax:"*";inherits:false}@property --tw-ordinal{syntax:"*";inherits:false}@property --tw-slashed-zero{syntax:"*";inherits:false}@property --tw-numeric-figure{syntax:"*";inherits:false}@property --tw-numeric-spacing{syntax:"*";inherits:false}@property --tw-numeric-fraction{syntax:"*";inherits:false}@property --tw-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-shadow-color{syntax:"*";inherits:false}@property --tw-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-inset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-shadow-color{syntax:"*";inherits:false}@property --tw-inset-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-ring-color{syntax:"*";inherits:false}@property --tw-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-inset-ring-color{syntax:"*";inherits:false}@property --tw-inset-ring-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-ring-inset{syntax:"*";inherits:false}@property --tw-ring-offset-width{syntax:"<length>";inherits:false;initial-value:0}@property --tw-ring-offset-color{syntax:"*";inherits:false;initial-value:#fff}@property --tw-ring-offset-shadow{syntax:"*";inherits:false;initial-value:0 0 #0000}@property --tw-blur{syntax:"*";inherits:false}@property --tw-brightness{syntax:"*";inherits:false}@property --tw-contrast{syntax:"*";inherits:false}@property --tw-grayscale{syntax:"*";inherits:false}@property --tw-hue-rotate{syntax:"*";inherits:false}@property --tw-invert{syntax:"*";inherits:false}@property --tw-opacity{syntax:"*";inherits:false}@property --tw-saturate{syntax:"*";inherits:false}@property --tw-sepia{syntax:"*";inherits:false}@property --tw-drop-shadow{syntax:"*";inherits:false}@property --tw-drop-shadow-color{syntax:"*";inherits:false}@property --tw-drop-shadow-alpha{syntax:"<percentage>";inherits:false;initial-value:100%}@property --tw-drop-shadow-size{syntax:"*";inherits:false}@property --tw-outline-style{syntax:"*";inherits:false;initial-value:solid}@keyframes spin{to{transform:rotate(360deg)}}@keyframes shimmer{0%{background-position:200% 0}to{background-position:-200% 0}}\n/*$vite$:1*/' };
}

// packages/web/src/launch.ts
import { spawn as spawn3 } from "node:child_process";
import { randomBytes } from "node:crypto";
async function launchDashboard(opts) {
  const workspace = new LocalWorkspace(opts.root, process.env, runCommand);
  const loaded = await loadConfig(workspace);
  if (!loaded.ok) throw new Error("norn's configuration does not load");
  const ctx = {
    github: new GhGitHub(),
    workspace,
    config: loaded.config,
    now: () => /* @__PURE__ */ new Date(),
    // The dashboard reads only: it takes no claims and sends no notifications.
    session: "dashboard",
    nonce: () => randomBytes(2).toString("hex"),
    notify: async () => {
    },
    slugs: /* @__PURE__ */ new Map()
  };
  const served = await serveDashboard(
    { ctx, root: opts.root, intervalMs: opts.intervalMs, assets: await uiAssets(), failure: ghFailure },
    { port: opts.port, explicit: opts.explicitPort }
  );
  if (served.kind !== "started") return served;
  const { url, port } = served.dashboard;
  return { kind: "started", url, port, opened: opts.open && openBrowser(url) };
}
function openBrowser(url) {
  const [cmd, args] = process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    const child = spawn3(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
    });
    child.unref();
    return true;
  } catch {
    return false;
  }
}

// packages/cli/src/bin.ts
try {
  const root = await LocalWorkspace.findRoot(process.cwd());
  const show = makeNotifier();
  const res = await run(process.argv.slice(2), {
    github: new GhGitHub(),
    workspace: new LocalWorkspace(root, process.env, runCommand, process.cwd()),
    now: () => /* @__PURE__ */ new Date(),
    session: sessionId(process.env, hostname(), root),
    nonce: () => randomBytes2(2).toString("hex"),
    notify: (channel, notification) => show(channel, renderNotification(notification)),
    cwd: root,
    installSkills,
    dashboard: launchDashboard
  });
  process.stdout.write(`${res.stdout}
`);
  process.exitCode = res.exitCode;
} catch (e) {
  if (e instanceof GhError) {
    process.stdout.write(`${ghFailureMessage(process.argv.slice(2), e.message)}
`);
    process.exitCode = 1;
  } else if (e instanceof RootError) {
    process.stdout.write(`${e.message}
`);
    process.exitCode = 1;
  } else throw e;
}
