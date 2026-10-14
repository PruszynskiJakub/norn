import type { GitHub, Issue } from "./github.js";
import { slugify } from "./text.js";

/**
 * The marker psdd writes once on a story, recording its slug. The story's
 * branch, slice branches, worktrees and spec path all derive from it, so
 * renaming the story on GitHub changes none of them.
 */
export const SLUG_MARK = "psdd: slug ";

/** Slugs read during one command, by story: the recorded slug, or null when none is recorded yet. */
export type Slugs = Map<number, string | null>;

interface SlugCtx {
  github: GitHub;
  slugs: Slugs;
}

/** The slug recorded on story n, read once per command. */
async function recorded(ctx: SlugCtx, n: number): Promise<string | null> {
  if (ctx.slugs.has(n)) return ctx.slugs.get(n)!;
  let slug: string | null = null;
  for (const body of await ctx.github.listComments(n)) {
    const line = body.split("\n").find((l) => l.startsWith(SLUG_MARK));
    if (line) slug = line.slice(SLUG_MARK.length).trim();
  }
  ctx.slugs.set(n, slug);
  return slug;
}

/** The story's slug: the recorded one, or for a story from before the marker, one from its current title. */
export async function storySlug(ctx: SlugCtx, story: Issue): Promise<string> {
  return (await recorded(ctx, story.number)) ?? slugify(story.title);
}

/**
 * The marker line to add to a comment psdd writes on the story while holding
 * its claim, or null when the slug is already recorded.
 */
export async function slugLine(ctx: SlugCtx, story: Issue): Promise<string | null> {
  if (await recorded(ctx, story.number)) return null;
  const slug = slugify(story.title);
  ctx.slugs.set(story.number, slug);
  return `${SLUG_MARK}${slug}`;
}
