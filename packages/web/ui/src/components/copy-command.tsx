import { useState } from "react";

/** The command to tell an agent, with a copy button. */
export function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard access can be refused; the command stays visible to copy by hand.
    }
  };
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: only stops the click from selecting the card underneath; the button inside is the control.
    // biome-ignore lint/a11y/useKeyWithClickEvents: as above, nothing here is operated by the click itself.
    <span
      onClick={(e) => e.stopPropagation()}
      className="inline-flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-0.5 font-mono text-[12.5px] text-soft"
    >
      {command}
      <button type="button" onClick={() => void copy()} className="border-0 bg-transparent p-0 font-sans text-[12px] text-faint hover:text-foreground">
        {copied ? "copied" : "copy"}
      </button>
    </span>
  );
}
