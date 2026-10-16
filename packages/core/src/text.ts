export function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

/** Names derived from a story take its recorded slug (see slug.ts), never its live title. */
export function specDir(n: number, slug: string) {
  return `.agents/specs/${n}-${slug}`;
}

export function specPath(n: number, slug: string) {
  return `${specDir(n, slug)}/spec.md`;
}

/**
 * Quotes a word for a POSIX shell command psdd prints. Plain paths and refs
 * stay as they are; anything else, e.g. a path with a space, is single-quoted.
 */
export function sh(word: string) {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

export function storyBranch(story: number, slug: string) {
  return `${story}-${slug}`;
}

export function sliceBranch(story: number, slug: string, slice: number) {
  return `${storyBranch(story, slug)}-${slice}`;
}

/** Every branch has its worktree at a fixed place. */
export function worktreePath(branch: string) {
  return `.agents/worktrees/${branch}`;
}
