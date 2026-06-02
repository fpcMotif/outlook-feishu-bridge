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

function submitDockButtonClass(live: boolean) {
  return cn(
    "submit-dock-btn flex h-14 w-full items-center justify-between gap-3 rounded-2xl px-5 text-[15px] font-semibold tracking-[-0.01em]",
    "transition-[background-color,box-shadow,color,transform] duration-150 ease-[var(--ease-out-strong)]",
    live
      ? "bg-primary text-primary-foreground enabled:active:scale-[0.96]"
      : "bg-muted/36 text-muted-foreground/72 cursor-not-allowed shadow-edge",
  );
}

const submitDockChromeClass = cn(
  "submit-dock relative z-10 mb-6 shrink-0 px-5 pt-2",
  "pb-[max(1.5rem,env(safe-area-inset-bottom,0px))]",
  "bg-background/92 supports-[backdrop-filter]:bg-background/76 supports-[backdrop-filter]:backdrop-blur-lg",
  "shadow-[0_-20px_44px_-34px_color-mix(in_oklch,var(--foreground)_10%,transparent)]",
);

const submitDockScrollFadeClass = cn(
  "pointer-events-none absolute inset-x-0 -top-9 h-9 bg-gradient-to-t to-transparent",
  "from-background via-background/55 supports-[backdrop-filter]:from-background/88 supports-[backdrop-filter]:via-background/40",
);

export function SubmitDock({
  count,
  canSubmit,
  sending,
  hint,
  label,
  onSubmit,
}: {
  count: number;
  canSubmit: boolean;
  sending: boolean;
  hint: string;
  label?: string;
  onSubmit: () => void;
}) {
  const live = canSubmit && !sending;
  const displayLabel = dockLabel({ count, sending, label, hint });

  return (
    <div className={submitDockChromeClass}>
      <div className={submitDockScrollFadeClass} />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!live}
        data-live={live ? "" : undefined}
        className={submitDockButtonClass(live)}
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-2">
          {sending ? <Loader2 className="size-4 shrink-0 animate-spin" /> : null}
          <span className="min-w-0 truncate text-pretty">{displayLabel}</span>
        </span>
        {live && count > 0 ? (
          <ArrowRight
            className="submit-dock-arrow size-[18px] shrink-0 opacity-90"
            aria-hidden
          />
        ) : null}
      </button>
    </div>
  );
}
