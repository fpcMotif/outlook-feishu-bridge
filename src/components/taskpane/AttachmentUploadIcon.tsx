import { useEffect, useReducer, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { iconFor } from "./attachmentFileDisplay";
import { uploadDisplayFrame } from "./uploadDisplayProgress";

type UploadOverlayPhase = "hidden" | "live" | "settling";

type UploadOverlayState = { phase: UploadOverlayPhase; wasActive: boolean };

function uploadOverlayReducer(
  state: UploadOverlayState,
  active: boolean,
): UploadOverlayState {
  if (active) return { phase: "live", wasActive: true };
  if (state.wasActive) return { phase: "settling", wasActive: false };
  return { phase: "hidden", wasActive: false };
}

// Mutable animation state, kept off React's render path so the rAF loop can
// advance the fill every frame without re-rendering until the value changes.
type FillAnim = {
  display: number;
  xhr: number;
  startedAt: number | null;
  lastTick: number | null;
};

function useSmoothedUploadProgress(
  progress: number,
  active: boolean,
  pending: boolean,
): number {
  const [display, setDisplay] = useState(0);
  const anim = useRef<FillAnim>({ display: 0, xhr: 0, startedAt: null, lastTick: null });

  // Snap back to empty the instant the row leaves the active states.
  const [prevActive, setPrevActive] = useState(active);
  if (prevActive !== active) {
    setPrevActive(active);
    if (!active && display !== 0) setDisplay(0);
  }

  useEffect(() => {
    const a = anim.current;
    if (!active) {
      a.display = 0;
      a.xhr = 0;
      a.startedAt = null;
      a.lastTick = null;
      return;
    }
    // Queued: hold the steady sliver. The ramp clock only starts once bytes flow,
    // so a file waiting behind the concurrency cap never creeps up a fake percent.
    if (pending) return;
    if (a.startedAt === null) a.startedAt = performance.now();
    // XHR only ever climbs — ignore a transient 0 so the fill never retreats.
    if (progress > 0) a.xhr = Math.max(a.xhr, progress);

    let frame = 0;
    const tick = (now: number) => {
      const dtMs = Math.max(0, now - (a.lastTick ?? now));
      a.lastTick = now;
      const elapsed = now - (a.startedAt ?? now);
      const { next, done } = uploadDisplayFrame(a.display, a.xhr, elapsed, dtMs);
      a.display = next;
      setDisplay(next);
      if (!done) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [progress, active, pending]);

  return display;
}

function useUploadOverlayPhase(active: boolean) {
  const [{ phase }, dispatch] = useReducer(uploadOverlayReducer, {
    phase: active ? "live" : "hidden",
    wasActive: false,
  });

  useEffect(() => {
    dispatch(active);
  }, [active]);

  useEffect(() => {
    if (phase !== "settling") return;
    const id = window.setTimeout(() => dispatch(false), 220);
    return () => window.clearTimeout(id);
  }, [phase]);

  const showOverlay = phase === "live" || phase === "settling";
  return { phase, showOverlay };
}

function UploadFillOverlay({
  phase,
  accent,
  fillScale,
}: {
  phase: UploadOverlayPhase;
  accent: string;
  fillScale: number;
}) {
  return (
    <span
      className={cn(
        "pointer-events-none absolute inset-[3px] overflow-hidden rounded-[9px]",
        "transition-opacity duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
        phase === "settling" && "opacity-0",
      )}
      aria-hidden="true"
    >
      <span
        className={cn(
          "absolute inset-0 origin-bottom opacity-55",
          accent,
          // The fill height is driven frame-by-frame in JS (a steady linear
          // climb), so the live phase paints each value directly with no CSS
          // tween. Only the final settle gets a short transition.
          phase === "settling"
            ? "transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none"
            : "transition-none",
        )}
        style={{ transform: `scaleY(${fillScale})` }}
      />
    </span>
  );
}

type UploadIconProps = {
  name: string;
  progress?: number;
  active: boolean;
  /** Queued behind the concurrency cap — bytes have not started flowing yet. */
  pending?: boolean;
};

function progressValueText(show: boolean, pct: number): string | undefined {
  if (!show) return undefined;
  return `${pct} percent uploaded`;
}

/** Upload rows: bottom fill inside the icon tile (scaleY, file accent). */
export function FileTypeIconWithUploadProgress(props: UploadIconProps) {
  const { name, progress = 0, active, pending = false } = props;
  const { Icon, tint, bg, border, accent } = iconFor(name);
  const { phase, showOverlay } = useUploadOverlayPhase(active);
  const smoothed = useSmoothedUploadProgress(progress, active, pending);
  // Visual fill follows the smoothed value; the accessible value reports the
  // real percent so screen readers hear true progress, not the simulated ramp.
  const pct = Math.min(100, Math.max(0, smoothed));
  const ariaPct = Math.min(100, Math.max(0, Math.round(progress)));
  // A queued/early row shows a thin steady sliver (0.04); the linear fill grows
  // continuously out of it once bytes flow. The final settle snaps to full.
  const fillScale = phase === "settling" ? 1 : Math.max(0.04, pct / 100);

  return (
    <span
      className="relative size-10 shrink-0"
      role={showOverlay ? "progressbar" : undefined}
      aria-valuemin={showOverlay ? 0 : undefined}
      aria-valuemax={showOverlay ? 100 : undefined}
      aria-valuenow={showOverlay ? ariaPct : undefined}
      aria-valuetext={progressValueText(showOverlay, ariaPct)}
      aria-label={showOverlay ? "Upload progress" : undefined}
    >
      <span
        className={cn(
          "flex size-10 items-center justify-center rounded-xl border",
          bg,
          border,
        )}
        aria-hidden="true"
      >
        <Icon className={cn("size-5", tint)} strokeWidth={1.75} />
      </span>
      {showOverlay ? (
        <UploadFillOverlay phase={phase} accent={accent} fillScale={fillScale} />
      ) : null}
    </span>
  );
}
