/* eslint-disable max-lines-per-function -- cohesive submit-dock component; the bulk is countdown-ring SVG markup. */
import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight } from "lucide-react";

import { cn } from "@/lib/utils";

const CONFIRM_COUNTDOWN_SECONDS = 3;

type ConfirmPhase = "idle" | "counting" | "ready";

// The chrome inputs every render of the dock button needs, regardless of whether
// a review countdown is currently armed. Passed as one object so the parent and the
// countdown gate hand the presentational button the same bundle without prop drift.
type SubmitDockChrome = {
  count: number;
  canSubmit: boolean;
  sending: boolean;
  hint: string;
  label?: string;
  confirmEnabled: boolean;
  confirmResetKey?: string;
  onSubmit: () => void;
};

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
  if (sending) return "Working";
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

function SubmitDockBusyLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <span className="min-w-0 truncate text-pretty">{label}</span>
      <span className="submit-dock-busy-dots inline-flex shrink-0 items-end gap-0.5" aria-hidden>
        <span className="submit-dock-busy-dot" />
        <span className="submit-dock-busy-dot" />
        <span className="submit-dock-busy-dot" />
      </span>
    </span>
  );
}

// Presentational button: pure function of (chrome, phase, remaining). Holds NO
// countdown state of its own, so it can never desync from the gate that drives it.
function DockButton({
  chrome,
  phase,
  remaining,
}: {
  chrome: SubmitDockChrome;
  phase: ConfirmPhase;
  remaining: number;
}) {
  const { count, canSubmit, sending, hint, label, confirmEnabled, confirmResetKey, onSubmit } = chrome;
  const live = canSubmit && !sending;
  const waitingForConfirm = confirmEnabled && live && phase !== "ready";
  const visuallyLive = live && !waitingForConfirm;
  const displayLabel = dockLabel({
    count,
    sending,
    label,
    hint,
    live,
    confirmEnabled,
    confirmPhase: confirmEnabled ? phase : "idle",
  });
  const showingConfirmCountdown = waitingForConfirm;
  const showingBusyFeedback = sending || showingConfirmCountdown;
  // The visual ring/number is aria-hidden, so the countdown is announced through
  // the sr-only live region below (the previous build left it silent for AT).
  const liveAnnouncement =
    confirmEnabled && live
      ? phase === "ready"
        ? "Attachments reviewed — ready to submit."
        : `Reviewing attachments — submitting in ${remaining} second${remaining === 1 ? "" : "s"}.`
      : "";
  const icon = useMemo(() => {
    if (sending) return null;
    if (!live || !confirmEnabled) return null;
    if (phase !== "ready") {
      return (
        // Countdown: a destructive ring depletes across the confirm window
        // (one continuous animation keyed to confirmResetKey so each review restarts it).
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
              className="[stroke:color-mix(in_oklch,var(--submit-dock-countdown-color)_22%,transparent)]"
            />
            <circle
              cx="14"
              cy="14"
              r="11"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="submit-dock-countdown-ring [stroke:var(--submit-dock-countdown-color)]"
              style={{ animationDuration: `${CONFIRM_COUNTDOWN_SECONDS}s` }}
            />
          </svg>
          <span
            key={remaining}
            className="animate-pop-in text-[12px] font-bold tabular-nums [color:var(--submit-dock-countdown-color)]"
          >
            {remaining}
          </span>
        </span>
      );
    }
    return <ArrowRight className="submit-dock-arrow size-[18px] shrink-0 opacity-90" aria-hidden />;
  }, [confirmEnabled, phase, remaining, confirmResetKey, live, sending]);

  const handleClick = () => {
    if (!live) return;
    // While confirm is armed, the button is disabled until the review window
    // elapses, so a click only ever lands when there's nothing left to wait for.
    if (!confirmEnabled || phase === "ready") onSubmit();
  };

  return (
    <>
      <button
        type="button"
        onClick={handleClick}
        disabled={!live || waitingForConfirm}
        data-live={visuallyLive ? "" : undefined}
        className={submitDockButtonClass(visuallyLive, confirmEnabled ? phase : "idle")}
      >
        {showingConfirmCountdown ? icon : null}
        <span className="inline-flex min-w-0 flex-1 items-center gap-2">
          {showingBusyFeedback ? (
            <SubmitDockBusyLabel label={displayLabel} />
          ) : (
            <span className="min-w-0 truncate text-pretty">{displayLabel}</span>
          )}
        </span>
        {showingConfirmCountdown ? null : icon}
      </button>
      {/* Countdown/readiness announcement for assistive tech; the visual ring is
          aria-hidden, so this is the only channel that voices the seconds. */}
      <span className="sr-only" aria-live="polite">
        {liveAnnouncement}
      </span>
    </>
  );
}

// The armed review window. Mounted with key={cycleKey} by the parent, so a changed
// form snapshot RECREATES this gate from scratch (React docs: "Resetting all state
// when a prop changes" → use a key). That remount is what reseeds the countdown —
// there is no render-phase ref tracker and no setState during render, so nothing can
// desync if React starts a render and discards it. The phase is derived, not stored.
function ConfirmCountdownGate({
  chrome,
  onReviewStart,
}: {
  chrome: SubmitDockChrome;
  onReviewStart?: () => void;
}) {
  const [remaining, setRemaining] = useState(CONFIRM_COUNTDOWN_SECONDS);
  const phase: ConfirmPhase = remaining > 0 ? "counting" : "ready";

  // onReviewStart is an inline prop (fresh identity each parent render). Read the
  // latest through a ref so the mount effect can fire it once WITHOUT taking an
  // unstable dependency — a legitimate ref: it never feeds the JSX or gates a render.
  const onReviewStartRef = useRef(onReviewStart);
  onReviewStartRef.current = onReviewStart;

  // SIDE EFFECTS ONLY: scroll the attachments into view once, then tick the window
  // down. Runs once per mount, i.e. once per cycleKey, because the parent's key
  // remounts this component on every change.
  useEffect(() => {
    onReviewStartRef.current?.();
    const timer = window.setInterval(() => {
      setRemaining((value) => {
        if (value <= 1) {
          window.clearInterval(timer);
          return 0;
        }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, []);

  return <DockButton chrome={chrome} phase={phase} remaining={remaining} />;
}

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

  // The single source of truth for the review countdown: a stable key for "the dock
  // is live and reviewable as this exact form snapshot". `null` whenever confirm is
  // off or the dock isn't live; any change to it remounts the gate and restarts the
  // window (the remount IS the reseed — no render-phase state sync needed).
  const cycleKey = confirmEnabled && live ? (confirmResetKey ?? "") : null;

  const chrome: SubmitDockChrome = {
    count,
    canSubmit,
    sending,
    hint,
    label,
    confirmEnabled,
    confirmResetKey,
    onSubmit,
  };

  return (
    <div className={submitDockChromeClass}>
      <div className={submitDockScrollFadeClass} />
      {cycleKey === null ? (
        <DockButton chrome={chrome} phase="idle" remaining={CONFIRM_COUNTDOWN_SECONDS} />
      ) : (
        <ConfirmCountdownGate key={cycleKey} chrome={chrome} onReviewStart={onReviewStart} />
      )}
    </div>
  );
}
