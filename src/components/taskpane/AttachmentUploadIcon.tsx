import { useEffect, useReducer, useRef, useState } from "react";

import { cn } from "@/lib/utils";

import { iconFor } from "./attachmentFileDisplay";
import {
  uploadDisplayProgressTarget,
  uploadSimulatedCap,
  uploadSmoothedStep,
} from "./uploadDisplayProgress";

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

function useSmoothedUploadProgress(progress: number, active: boolean): number {
  const [display, setDisplay] = useState(0);
  const displayRef = useRef(0);
  const xhrRef = useRef(0);
  const startedAtRef = useRef<number | null>(null);

  // Reset the eased fill during render — React's "adjusting state on a prop
  // change" pattern — so the icon never paints a stale frame between commits.
  // The prev-prop guard fires ONLY on a real active/progress transition (never
  // on benign re-renders); the ref resets stay in the effect below, so the
  // monotonic fill survives the restart race (teach upload-progress-async/0001).
  const [prev, setPrev] = useState({ active, progress });
  if (prev.active !== active || prev.progress !== progress) {
    setPrev({ active, progress });
    if ((!active || progress <= 0) && display !== 0) {
      setDisplay(0);
    }
  }

  useEffect(() => {
    if (!active) {
      displayRef.current = 0;
      xhrRef.current = 0;
      startedAtRef.current = null;
      return;
    }

    if (startedAtRef.current === null) {
      startedAtRef.current = performance.now();
    }

    if (progress <= 0) {
      xhrRef.current = 0;
      displayRef.current = 0;
    } else {
      xhrRef.current = Math.max(xhrRef.current, progress);
    }

    let frame = 0;
    const tick = () => {
      const elapsed = performance.now() - (startedAtRef.current ?? performance.now());
      const mergedIncoming = Math.max(xhrRef.current, uploadSimulatedCap(elapsed));
      const target = uploadDisplayProgressTarget(displayRef.current, mergedIncoming, true);
      const { next, done } = uploadSmoothedStep(displayRef.current, target);
      displayRef.current = next;
      setDisplay(next);
      if (!done || mergedIncoming < 100) {
        frame = requestAnimationFrame(tick);
      }
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [progress, active]);

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
  indeterminate,
  accent,
  fillScale,
}: {
  phase: UploadOverlayPhase;
  indeterminate: boolean;
  accent: string;
  fillScale: number | undefined;
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
          phase === "settling" &&
            "transition-transform duration-200 ease-[var(--ease-out-strong)] motion-reduce:transition-none",
          phase === "live" && !indeterminate && "transition-none",
          phase === "live" &&
            indeterminate &&
            "motion-safe:animate-[upload-fill-indeterminate_1.2s_ease-in-out_infinite] motion-reduce:scale-y-[0.35]",
        )}
        style={
          fillScale === undefined
            ? undefined
            : { transform: `scaleY(${fillScale})` }
        }
      />
    </span>
  );
}

type UploadIconProps = {
  name: string;
  progress?: number;
  active: boolean;
  indeterminate?: boolean;
};

function progressValueText(
  show: boolean,
  pct: number | undefined,
): string | undefined {
  if (!show) return undefined;
  return pct === undefined ? "Uploading" : `${pct} percent uploaded`;
}

/** Upload rows: bottom fill inside the icon tile (scaleY, file accent). */
export function FileTypeIconWithUploadProgress(props: UploadIconProps) {
  const { name, progress = 0, active, indeterminate = false } = props;
  const { Icon, tint, bg, border, accent } = iconFor(name);
  const { phase, showOverlay } = useUploadOverlayPhase(active);
  const smoothed = useSmoothedUploadProgress(progress, active);
  // Visual fill follows the smoothed value; the accessible value reports the
  // real percent so screen readers hear true progress, not the eased ramp.
  const pct = indeterminate ? undefined : Math.min(100, Math.max(0, smoothed));
  const ariaPct = indeterminate
    ? undefined
    : Math.min(100, Math.max(0, Math.round(progress)));
  const fillScale =
    phase === "settling"
      ? 1
      : indeterminate
        ? undefined
        : Math.max(0.04, (pct ?? 0) / 100);

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
        <UploadFillOverlay
          phase={phase}
          indeterminate={indeterminate}
          accent={accent}
          fillScale={fillScale}
        />
      ) : null}
    </span>
  );
}
