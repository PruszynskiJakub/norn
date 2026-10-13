export function slugify(title: string) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 50)
    .replace(/-+$/, "");
}

export function specDir(n: number, title: string) {
  return `.agents/specs/${n}-${slugify(title)}`;
}

export function specPath(n: number, title: string) {
  return `${specDir(n, title)}/spec.md`;
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

export function storyBranch(n: number, title: string) {
  return `story/${n}-${slugify(title)}`;
}

export function sliceBranch(n: number, title: string) {
  return `slice/${n}-${slugify(title)}`;
}
