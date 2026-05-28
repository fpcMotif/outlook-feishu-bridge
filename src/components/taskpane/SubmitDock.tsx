import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

function dockLabel({
  count,
  sending,
  label,
  hint,
}: {
  count: number;
  sending: boolean;
  label?: string;
  hint: string;
}) {
  if (sending) return "Submitting...";
  if (label) return label;
  if (count > 0) return `Submit ${count} request${count > 1 ? "s" : ""}`;
  return hint;
}

export function SubmitDock({
  count,
  canSubmit,
  sending,
  hint,
  label,
  footer,
  onSubmit,
}: {
  count: number;
  canSubmit: boolean;
  sending: boolean;
  hint: string;
  label?: string;
  footer?: string;
  onSubmit: () => void;
}) {
  const live = canSubmit && !sending;
  const displayLabel = dockLabel({ count, sending, label, hint });

  return (
    <div className="bg-background relative z-10 shrink-0 px-5 pt-3 pb-2 shadow-[0_-18px_42px_-34px_color-mix(in_oklch,var(--primary)_42%,transparent)]">
      <div className="from-background pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t to-transparent" />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!live}
        className={cn(
          "flex h-14 w-full items-center justify-between rounded-[18px] px-5 text-[15px] font-semibold transition-[background-color,color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)]",
          live
            ? "bg-primary text-primary-foreground shadow-[var(--shadow-floating)] hover:bg-primary-deep active:scale-[0.97]"
            : "bg-secondary text-muted-foreground cursor-not-allowed shadow-[var(--shadow-border)]",
        )}
      >
        <span className="inline-flex min-w-0 items-center gap-2">
          {sending ? <Loader2 className="size-4 animate-spin" /> : null}
          <span className="truncate">{displayLabel}</span>
        </span>
        {live && count > 0 ? <ArrowRight className="size-[18px] shrink-0" /> : null}
      </button>
      <div className="text-muted-foreground mt-2 truncate text-center text-[11px]">
        {footer ?? "Encrypted - synced to your Feishu workspace"}
      </div>
    </div>
  );
}
