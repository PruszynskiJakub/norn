import type { ReactNode } from "react";

// A small markdown renderer for the agents' remarks: paragraphs, lists,
// checklists, ``` blocks, headings, `code`, **bold** and links. Everything
// becomes React elements, so the remark's text is escaped by React and no
// HTML from it ever reaches the page.

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(!?\[([^\]]*)\]\(([^)\s]+)\))/g;

function safeUrl(url: string): string | null {
  return /^https?:\/\//i.test(url) ? url : null;
}

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    const key = out.length;
    if (m[1]) {
      out.push(
        <code key={key} className="rounded-[5px] bg-muted px-[5px] py-px font-mono text-[12.5px]">
          {m[1].slice(1, -1)}
        </code>,
      );
    } else if (m[2]) {
      out.push(
        <b key={key} className="font-semibold text-foreground">
          {m[2].slice(2, -2)}
        </b>,
      );
    } else {
      const label = m[4] || m[5]!;
      const url = safeUrl(m[5]!);
      out.push(
        url ? (
          <a key={key} href={url} target="_blank" rel="noreferrer" className="underline underline-offset-3">
            {label}
          </a>
        ) : (
          label
        ),
      );
    }
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** A parsed block; `key` is its position in the remark, which is stable for the same remark. */
type Block = { key: number } & (
  | { kind: "p"; text: string }
  | { kind: "h"; text: string }
  | { kind: "pre"; text: string }
  | { kind: "ul" | "ol"; items: { key: number; text: string; check: boolean | null }[] }
);
type NewBlock = Block extends infer B ? (B extends Block ? Omit<B, "key"> : never) : never;

function parse(src: string): Block[] {
  const blocks: Block[] = [];
  const push = (b: NewBlock) => blocks.push({ ...b, key: blocks.length } as Block);
  let para: string[] = [];
  let code: string[] | null = null;
  const flush = () => {
    if (para.length) push({ kind: "p", text: para.join(" ") });
    para = [];
  };
  const listOf = (kind: "ul" | "ol") => {
    const prev = blocks[blocks.length - 1];
    if (prev && prev.kind === kind && para.length === 0) return prev;
    flush();
    push({ kind, items: [] });
    return blocks[blocks.length - 1]!;
  };
  let inList = false;
  for (const line of src.replace(/\r\n/g, "\n").split("\n")) {
    if (code) {
      if (line.trimStart().startsWith("```")) {
        push({ kind: "pre", text: code.join("\n") });
        code = null;
      } else code.push(line);
      continue;
    }
    if (line.trimStart().startsWith("```")) {
      flush();
      inList = false;
      code = [];
      continue;
    }
    const heading = line.match(/^#{1,6} (.*)/);
    if (heading) {
      flush();
      inList = false;
      push({ kind: "h", text: heading[1]! });
      continue;
    }
    const check = line.match(/^\s*[-*] \[( |x|X)\] (.*)/);
    const bullet = line.match(/^\s*[-*] (.*)/);
    const numbered = line.match(/^\s*\d+[.)] (.*)/);
    if (check || bullet || numbered) {
      const list = listOf(numbered && !check && !bullet ? "ol" : "ul") as Extract<Block, { kind: "ul" | "ol" }>;
      const key = list.items.length;
      if (check) list.items.push({ key, text: check[2]!, check: check[1] !== " " });
      else list.items.push({ key, text: (bullet ?? numbered)![1]!, check: null });
      inList = true;
      continue;
    }
    if (!line.trim()) {
      flush();
      inList = false;
      continue;
    }
    // A line right under a list item continues it, as GitHub renders it.
    const prev = blocks[blocks.length - 1];
    if (inList && prev && (prev.kind === "ul" || prev.kind === "ol")) {
      const item = prev.items[prev.items.length - 1]!;
      item.text = `${item.text} ${line.trim()}`;
      continue;
    }
    para.push(line.trim());
  }
  if (code) push({ kind: "pre", text: code.join("\n") });
  flush();
  return blocks;
}

/** An agent's remark, rendered. */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="text-[14px] leading-[1.65] text-soft [&>:last-child]:mb-0">
      {parse(source).map((b) => {
        switch (b.kind) {
          case "p":
            return (
              <p key={b.key} className="mt-0 mb-2">
                {inline(b.text)}
              </p>
            );
          case "h":
            return (
              <h4 key={b.key} className="mt-2.5 mb-1 font-semibold text-[13px] text-foreground">
                {inline(b.text)}
              </h4>
            );
          case "pre":
            return (
              <pre key={b.key} className="mt-1.5 mb-2.5 overflow-x-auto rounded-[10px] bg-background/60 px-3 py-2.5 font-mono text-[12.5px]">
                {b.text}
              </pre>
            );
          case "ul":
          case "ol": {
            const Tag = b.kind;
            return (
              <Tag key={b.key} className={b.kind === "ul" ? "mt-0.5 mb-2 list-disc pl-5" : "mt-0.5 mb-2 list-decimal pl-5"}>
                {b.items.map((it) => (
                  <li key={it.key} className={it.check === null ? "my-[3px]" : "my-[3px] -ml-5 list-none"}>
                    {it.check !== null && (
                      <span role="img" aria-label={it.check ? "checked" : "not checked"} className={it.check ? "mr-1.5 text-ok" : "mr-1.5 text-faint"}>
                        {it.check ? "☑" : "☐"}
                      </span>
                    )}
                    {inline(it.text)}
                  </li>
                ))}
              </Tag>
            );
          }
          default:
            return b satisfies never;
        }
      })}
    </div>
  );
}
