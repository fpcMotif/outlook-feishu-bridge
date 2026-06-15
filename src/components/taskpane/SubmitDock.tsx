import { useEffect, useMemo, useState } from "react";
import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

const CONFIRM_COUNTDOWN_SECONDS = 3;

type ConfirmPhase = "idle" | "counting" | "ready";

function dockLabel({
  count,
  sending,
  label,
  hint,
  live,
  confirmEnabled,
  confirmPhase,
}: {
  count: number;
  sending: boolean;
  label?: string;
  hint: string;
  live: boolean;
  confirmEnabled: boolean;
  confirmPhase: ConfirmPhase;
}) {
  if (sending) return "Submitting...";
  if (confirmEnabled && live && confirmPhase === "idle") return "Checking attachments";
  if (confirmPhase === "counting") return "Checking attachments";
  if (confirmPhase === "ready") {
    if (label) return label;
    if (count > 0) return `Submit ${count} request${count > 1 ? "s" : ""}`;
    return hint;
  }
  if (label) return label;
  if (count > 0) return `Submit ${count} request${count > 1 ? "s" : ""}`;
  return hint;
}

function submitDockButtonClass(live: boolean, confirmPhase: ConfirmPhase) {
  return cn(
    "submit-dock-btn flex h-14 w-full items-center justify-between gap-3 rounded-2xl px-5 text-[15px] font-semibold tracking-[-0.01em]",
    "transition-[background-color,box-shadow,color,transform] duration-150 ease-[var(--ease-out-strong)]",
    confirmPhase === "ready" ? "shadow-[0_14px_34px_-20px_color-mix(in_oklch,var(--primary)_60%,transparent)]" : "",
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
  confirmResetKey,
  onReviewStart,
  onSubmit,
}: {
  count: number;
  canSubmit: boolean;
  sending: boolean;
  hint: string;
  label?: string;
  confirmResetKey?: string;
  onReviewStart?: () => void;
  onSubmit: () => void;
}) {
  const live = canSubmit && !sending;
  const confirmEnabled = confirmResetKey !== undefined;
  const [confirmPhase, setConfirmPhase] = useState<ConfirmPhase>("idle");
  const [confirmRemaining, setConfirmRemaining] = useState(CONFIRM_COUNTDOWN_SECONDS);
  const waitingForConfirm = confirmEnabled && live && confirmPhase !== "ready";
  const visuallyLive = live && !waitingForConfirm;
  const displayConfirmPhase =
    confirmEnabled && live && confirmPhase === "idle"
      ? "counting"
      : confirmEnabled
        ? confirmPhase
        : "idle";
  const displayLabel = dockLabel({
    count,
    sending,
    label,
    hint,
    live,
    confirmEnabled,
    confirmPhase: displayConfirmPhase,
  });
  const icon = useMemo(() => {
    if (sending) return <Loader2 className="size-4 shrink-0 animate-spin" />;
    if (!live || !confirmEnabled) return null;
    if (confirmPhase !== "ready") {
      return (
        // Countdown: a primary ring that depletes across the confirm window
        // (one continuous animation keyed to confirmResetKey so each review
        // restarts it), with the remaining seconds popping in beneath it.
        <span
          key={confirmResetKey}
          className="relative inline-flex size-7 shrink-0 items-center justify-center"
          aria-hidden
        >
          <svg className="absolute inset-0 size-7 -rotate-90" viewBox="0 0 28 28" fill="none">
            <circle
              cx="14"
              cy="14"
              r="11"
              strokeWidth="2.5"
              className="[stroke:color-mix(in_oklch,var(--foreground)_14%,transparent)]"
            />
            <circle
              cx="14"
              cy="14"
              r="11"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="submit-dock-countdown-ring [stroke:var(--primary)]"
              style={{ animationDuration: `${CONFIRM_COUNTDOWN_SECONDS}s` }}
            />
          </svg>
          <span
            key={confirmRemaining}
            className="animate-pop-in text-[12px] font-bold tabular-nums text-foreground/75"
          >
            {confirmRemaining}
          </span>
        </span>
      );
    }
    if (confirmPhase === "ready") {
      return <ArrowRight className="submit-dock-arrow size-[18px] shrink-0 opacity-90" aria-hidden />;
    }
    return null;
  }, [confirmEnabled, confirmPhase, confirmRemaining, confirmResetKey, live, sending]);

  useEffect(() => {
    setConfirmPhase("idle");
    setConfirmRemaining(CONFIRM_COUNTDOWN_SECONDS);
  }, [confirmResetKey, live]);

  useEffect(() => {
    if (!confirmEnabled || !live || confirmPhase !== "idle") return;
    onReviewStart?.();
    setConfirmPhase("counting");
    setConfirmRemaining(CONFIRM_COUNTDOWN_SECONDS);
  }, [confirmEnabled, confirmPhase, live, onReviewStart]);

  useEffect(() => {
    if (confirmPhase !== "counting") return undefined;
    const timer = window.setInterval(() => {
      setConfirmRemaining((remaining) => {
        if (remaining <= 1) {
          setConfirmPhase("ready");
          return 0;
        }
        return remaining - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [confirmPhase]);

  const handleClick = () => {
    if (!live) return;
    if (!confirmEnabled) {
      onSubmit();
      return;
    }
    if (confirmPhase === "counting") return;
    if (confirmPhase === "ready") {
      onSubmit();
      return;
    }
    onReviewStart?.();
    setConfirmPhase("counting");
    setConfirmRemaining(CONFIRM_COUNTDOWN_SECONDS);
  };

  return (
    <div className={submitDockChromeClass}>
      <div className={submitDockScrollFadeClass} />
      <button
        type="button"
        onClick={handleClick}
        disabled={!live || waitingForConfirm}
        data-live={visuallyLive ? "" : undefined}
        aria-live={confirmPhase === "idle" ? undefined : "polite"}
        className={submitDockButtonClass(visuallyLive, displayConfirmPhase)}
      >
        <span className="inline-flex min-w-0 flex-1 items-center gap-2">
          <span className="min-w-0 truncate text-pretty">{displayLabel}</span>
        </span>
        {icon}
      </button>
    </div>
  );
}
