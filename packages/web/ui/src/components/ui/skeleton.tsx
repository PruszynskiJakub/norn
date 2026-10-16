import { cn } from "../../lib/utils.ts";

export function Skeleton({ className, height }: { className?: string; height: number }) {
  return (
    <div
      className={cn("my-2.5 animate-shimmer rounded-[10px] bg-[linear-gradient(90deg,var(--muted),var(--border),var(--muted))] bg-size-[200%_100%]", className)}
      style={{ height }}
    />
  );
}

/** A few skeleton rows of one height. */
export function Skeletons({ count, height }: { count: number; height: number }) {
  // biome-ignore lint/suspicious/noArrayIndexKey: identical placeholders that never reorder.
  return Array.from({ length: count }, (_, i) => <Skeleton key={i} height={height} />);
}
