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
  return /^[A-Za-z0-9_\-.\/:=@%+,]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`;
}

/** Hard-wraps prose to the given width, keeping existing line breaks. */
export function wrap(text: string, width = 76) {
  return text
    .split("\n")
    .map((line) => {
      const out: string[] = [];
      let cur = "";
      for (const word of line.split(" ")) {
        if (cur && (cur + " " + word).length > width) {
          out.push(cur);
          cur = word;
        } else cur = cur ? cur + " " + word : word;
      }
      out.push(cur);
      return out.join("\n");
    })
    .join("\n");
}

export function hhmm(iso: string) {
  return iso.slice(11, 16);
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
