import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "../../lib/utils.ts";

const buttonVariants = cva(
  "inline-flex items-center gap-1.5 whitespace-nowrap border-0 bg-transparent font-[inherit] transition-colors focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-60",
  {
    variants: {
      variant: {
        quiet: "rounded-lg px-2 py-1 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground",
        link: "p-0 text-[13px] text-muted-foreground hover:text-foreground hover:underline hover:underline-offset-3",
        faint: "p-0 text-[13px] text-faint hover:text-foreground",
      },
    },
    defaultVariants: { variant: "quiet" },
  },
);

export function Button({ className, variant, type = "button", ...props }: ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button type={type} className={cn(buttonVariants({ variant }), className)} {...props} />;
}
