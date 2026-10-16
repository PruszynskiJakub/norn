import type { Evidence } from "@shepherd/core";
import type { ReactNode } from "react";
import { links } from "../model.ts";
import { useView } from "../view.ts";
import { files } from "../wording.ts";

function MaybeLink({ href, className, title, children }: { href: string | null; className?: string; title?: string; children: ReactNode }) {
  if (!href)
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  return (
    <a href={href} target="_blank" rel="noreferrer" className={className} title={title}>
      {children}
    </a>
  );
}

/** Links to a QA run's evidence: its branch, the commit that run pushed, and (unless compact) each file. */
export function EvidenceBlock({ evidence, compact = false }: { evidence: Evidence; compact?: boolean }) {
  const { state } = useView();
  const repo = state.repoUrl;
  const head = (
    <>
      <MaybeLink
        href={links.branch(repo, evidence.branch)}
        className="font-mono text-[12.5px] text-ok"
        title="the branch with every QA run's evidence for this issue"
      >
        ⑂ {evidence.branch}
      </MaybeLink>
      <MaybeLink href={links.commit(repo, evidence.sha)} className="font-mono text-[12.5px] text-muted-foreground" title="the commit this QA run pushed">
        @{evidence.sha.slice(0, 7)}
      </MaybeLink>
      <span className="text-[13px] text-muted-foreground">{files(evidence.files.length)}</span>
    </>
  );
  if (compact) return <div className="mt-2 inline-flex flex-wrap items-center gap-2.5 rounded-[10px] border border-border bg-card px-2.5 py-1">{head}</div>;
  return (
    <div className="mt-3 overflow-hidden rounded-[10px] border border-border bg-card">
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 text-[13px]">{head}</div>
      {evidence.files.length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1 px-3 pt-1 pb-2.5 font-mono text-[12.5px]">
          {evidence.files.map((f) => (
            <MaybeLink key={f} href={links.file(repo, evidence.sha, f)} className="text-muted-foreground hover:text-foreground">
              {f}
            </MaybeLink>
          ))}
        </div>
      )}
    </div>
  );
}
