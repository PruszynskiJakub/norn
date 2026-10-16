import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const badgeVariants = cva("inline-flex items-center whitespace-nowrap rounded-md border px-1.5 py-px font-mono text-[11.5px] leading-[1.6]", {
  variants: {
    tone: {
      neutral: "border-border bg-muted text-muted-foreground",
      warn: "border-transparent bg-warn-bg text-warn",
      bad: "border-transparent bg-bad-bg text-bad",
    },
  },
  defaultVariants: { tone: "neutral" },
});

export function Badge({ className, tone, ...props }: ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}
