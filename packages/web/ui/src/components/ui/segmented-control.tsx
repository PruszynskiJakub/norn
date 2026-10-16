import { cn } from "../../lib/utils.ts";

/** A row of mutually exclusive choices, shadcn's tabs list in miniature. */
export function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <fieldset aria-label={label} className="m-0 inline-flex min-w-0 gap-0.5 rounded-[10px] border-0 bg-muted p-[3px]">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
          className={cn(
            "rounded-lg border-0 bg-transparent px-3 py-0.5 text-[13px] text-muted-foreground",
            o.value === value && "bg-card text-foreground shadow-[0_1px_2px_rgba(0,0,0,.06)]",
          )}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}
