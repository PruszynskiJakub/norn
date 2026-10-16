import {
  type ClaimRecord,
  type ClaimRef,
  isPsddComment,
  type LinkedPullRequest,
  type ObservedIssue,
  type ObservedStory,
  type TimelineItem,
  type Work,
  type WorkQuery,
} from "@psdd/core";

/** Runs one GraphQL request through gh; `vars` go in as -F name=value. */
export type GraphQl = (query: string, vars: Record<string, string | number | null>) => Promise<unknown>;
/** The claim refs on origin: sha and ref name per line, as git ls-remote prints them. */
export type LsRemote = () => Promise<string>;

/*
 * GitHub charges GraphQL by the connections a query could fetch, so every
 * issue carries only three: labels, blockers, and one timeline that holds
 * psdd's comments, label changes and the PRs that mention it. The timeline is
 * read whole, since psdd's comments over the whole history give fix rounds and
 * the slug, and filtered to `since` here.
 */
const TIMELINE_TYPES = [
  "LABELED_EVENT",
  "UNLABELED_EVENT",
  "ISSUE_COMMENT",
  "CLOSED_EVENT",
  "REOPENED_EVENT",
  "SUB_ISSUE_ADDED_EVENT",
  "CROSS_REFERENCED_EVENT",
  "RENAMED_TITLE_EVENT",
  "ASSIGNED_EVENT",
  "UNASSIGNED_EVENT",
].join(", ");

const TIMELINE_NODES = `pageInfo { hasNextPage endCursor }
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

export const FRAGMENTS = `fragment Item on Issue {
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

const STORIES = `query($owner: String!, $name: String!, $user: String!, $closedSince: DateTime!, $openAfter: String, $closedAfter: String) {
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

const MORE_TIMELINE = `query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { timelineItems(first: 100, after: $after, itemTypes: [${TIMELINE_TYPES}]) { ${TIMELINE_NODES} } } }
}`;

const MORE_SUB_ISSUES = `query($id: ID!, $after: String) {
  node(id: $id) { ... on Issue { subIssues(first: 20, after: $after) { pageInfo { hasNextPage endCursor } nodes { ...Item } } } }
}
${FRAGMENTS}`;

interface Page<T> {
  pageInfo?: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}
type Login = { login: string } | null;
interface RawPr {
  number?: number;
  url: string;
  headRefName: string;
  baseRefName: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  createdAt: string;
  mergedAt: string | null;
  author: Login;
  mergedBy: Login;
}
interface RawEvent {
  __typename: string;
  createdAt?: string;
  actor?: Login;
  author?: Login;
  label?: { name: string };
  url?: string;
  body?: string;
  subIssue?: { number: number };
  source?: RawPr | Record<string, never>;
}
interface RawItem {
  id: string;
  number: number;
  title: string;
  url: string;
  state: "OPEN" | "CLOSED";
  stateReason: string | null;
  closedAt: string | null;
  repository: { url: string };
  labels: Page<{ name: string }>;
  /** Read for stories only: a slice's owner is its story's. */
  assignees?: Page<{ login: string }>;
  blockedBy: Page<{ number: number; state: "OPEN" | "CLOSED" }>;
  timelineItems: Page<RawEvent>;
  subIssues?: Page<RawItem>;
}

/** Claim refs as git ls-remote prints them; anything not under refs/psdd/claims/<number> is not a claim. */
export function parseLsRemote(out: string): { issue: number; sha: string }[] {
  return out.split("\n").flatMap((line) => {
    const m = /^([0-9a-f]{40})\s+refs\/psdd\/claims\/(\d+)$/.exec(line.trim());
    return m ? [{ issue: Number(m[2]), sha: m[1] }] : [];
  });
}

/** The developer's work: one query for the stories and claim records, more only for long lists and claims outside them. */
export async function observeWork(graphql: GraphQl, lsRemote: LsRemote, query: WorkQuery): Promise<Work> {
  const refs = parseLsRemote(await lsRemote());
  // The claim records are the messages of the commits the refs point at, read in the same query.
  const claimFields = refs.map((r, i) => `c${i}: object(oid: "${r.sha}") { ... on Commit { message } }`).join("\n    ");
  const text = STORIES.replace("__CLAIMS__", claimFields);
  type Repo = { url: string; open: Page<RawItem>; closed: Page<RawItem> } & Record<string, unknown>;
  const read = async (openAfter: string | null, closedAfter: string | null) =>
    ((await graphql(text, { user: query.user, closedSince: query.closedSince, openAfter, closedAfter })) as { data: { repository: Repo } }).data.repository;

  const first = await read(null, null);
  const raws = [...first.open.nodes, ...first.closed.nodes];
  let { open, closed } = first;
  while (open.pageInfo?.hasNextPage || closed.pageInfo?.hasNextPage) {
    const next = await read(open.pageInfo?.hasNextPage ? open.pageInfo.endCursor : null, closed.pageInfo?.hasNextPage ? closed.pageInfo.endCursor : null);
    // A list that is done is read again from its start; only the one paged on counts.
    if (open.pageInfo?.hasNextPage) raws.push(...next.open.nodes);
    if (closed.pageInfo?.hasNextPage) raws.push(...next.closed.nodes);
    open = open.pageInfo?.hasNextPage ? next.open : { nodes: [] };
    closed = closed.pageInfo?.hasNextPage ? next.closed : { nodes: [] };
  }

  const claims: ClaimRef[] = refs.map((r, i) => ({ ...r, record: claimRecord(first[`c${i}`]) }));
  const repoUrl = first.url;
  const stories: ObservedStory[] = [];
  for (const raw of raws) stories.push(await story(graphql, raw, repoUrl, query.since));

  // A claim of the user's on an item outside these stories brings that item's story in.
  const known = new Set(stories.flatMap((s) => [s.number, ...s.subIssues.map((i) => i.number)]));
  const outside = claims.filter((c) => c.record?.holder === query.user && !known.has(c.issue));
  if (outside.length) {
    const fields = outside.map((c, i) => `x${i}: issue(number: ${c.issue}) { ...Story parent { ...Story } }`).join("\n    ");
    const res = (await graphql(
      `query($owner: String!, $name: String!) {\n  repository(owner: $owner, name: $name) {\n    ${fields}\n  }\n}\n${FRAGMENTS}`,
      {},
    )) as {
      data: { repository: Record<string, (RawItem & { parent: RawItem | null }) | null> };
    };
    for (const hit of Object.values(res.data.repository)) {
      const raw = hit?.labels.nodes.some((l) => l.name === "type:story") ? hit : hit?.parent;
      if (raw && !stories.some((s) => s.number === raw.number)) stories.push(await story(graphql, raw, repoUrl, query.since));
    }
  }
  return { repoUrl, stories, claims };
}

function claimRecord(object: unknown): ClaimRecord | null {
  try {
    const r = JSON.parse((object as { message: string }).message) as ClaimRecord;
    return typeof r.holder === "string" && typeof r.session === "string" && typeof r.since === "string" ? r : null;
  } catch {
    return null;
  }
}

async function story(graphql: GraphQl, raw: RawItem, repoUrl: string, since: string | null): Promise<ObservedStory> {
  const subs = [...(raw.subIssues?.nodes ?? [])];
  let page = raw.subIssues?.pageInfo;
  while (page?.hasNextPage) {
    const res = (await graphql(MORE_SUB_ISSUES, { id: raw.id, after: page.endCursor })) as { data: { node: { subIssues: Page<RawItem> } } };
    subs.push(...res.data.node.subIssues.nodes);
    page = res.data.node.subIssues.pageInfo;
  }
  // Sub-issues may live in other repositories; their numbers mean nothing here.
  const here = subs.filter((s) => s.repository.url === repoUrl);
  const subIssues: ObservedIssue[] = [];
  for (const s of here) subIssues.push(await issue(graphql, s, since));
  return { ...(await issue(graphql, raw, since)), subIssues };
}

async function issue(graphql: GraphQl, raw: RawItem, since: string | null): Promise<ObservedIssue> {
  const events = [...raw.timelineItems.nodes];
  let page = raw.timelineItems.pageInfo;
  while (page?.hasNextPage) {
    const res = (await graphql(MORE_TIMELINE, { id: raw.id, after: page.endCursor })) as { data: { node: { timelineItems: Page<RawEvent> } } };
    events.push(...res.data.node.timelineItems.nodes);
    page = res.data.node.timelineItems.pageInfo;
  }
  const timeline: TimelineItem[] = [];
  const pullRequests = new Map<number, LinkedPullRequest>();
  for (const e of events) {
    if (e.__typename === "CrossReferencedEvent") {
      const pr = e.source as RawPr;
      if (pr?.number !== undefined) pullRequests.set(pr.number, toPr(pr as RawPr & { number: number }));
      continue;
    }
    const item = toItem(e);
    if (item) timeline.push(item);
  }
  const labels = raw.labels.nodes.map((l) => l.name);
  const observed: ObservedIssue = {
    number: raw.number,
    title: raw.title,
    state: raw.state === "OPEN" ? "open" : "closed",
    labels,
    assignees: raw.assignees?.nodes.map((a) => a.login) ?? [],
    url: raw.url,
    closedAt: raw.closedAt,
    blockedBy: raw.blockedBy.nodes.map((b) => ({ number: b.number, state: b.state === "OPEN" ? "open" : "closed" })),
    psddComments: timeline.flatMap((t) => (t.kind === "comment" && t.body !== null ? [{ body: t.body, at: t.at, actor: t.actor, url: t.url }] : [])),
    pullRequests: [...pullRequests.values()],
    timeline: timeline.filter((t) => since === null || t.at > since),
  };
  if (raw.stateReason === "COMPLETED") observed.stateReason = "completed";
  if (raw.stateReason === "NOT_PLANNED") observed.stateReason = "not_planned";
  return observed;
}

function toPr(pr: RawPr & { number: number }): LinkedPullRequest {
  return {
    number: pr.number,
    url: pr.url,
    head: pr.headRefName,
    base: pr.baseRefName,
    state: pr.state === "MERGED" ? "merged" : pr.state === "OPEN" ? "open" : "closed",
    createdAt: pr.createdAt,
    mergedAt: pr.mergedAt,
    author: pr.author?.login ?? null,
    mergedBy: pr.mergedBy?.login ?? null,
  };
}

function toItem(e: RawEvent): TimelineItem | null {
  const at = e.createdAt ?? "";
  const actor = (e.actor ?? e.author)?.login ?? null;
  switch (e.__typename) {
    case "LabeledEvent":
    case "UnlabeledEvent":
      return e.label ? { kind: e.__typename === "LabeledEvent" ? "labeled" : "unlabeled", label: e.label.name, at, actor } : null;
    case "IssueComment":
      // Only psdd's own comments travel with their body; a person's stays theirs.
      return { kind: "comment", at, actor, url: e.url ?? "", body: e.body !== undefined && isPsddComment(e.body) ? e.body : null };
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
