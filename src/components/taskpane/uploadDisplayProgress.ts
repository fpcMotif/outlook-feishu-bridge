/** Simulated byte progress while XHR is quiet (caps below real upload %). */
const UPLOAD_SIMULATED_CAP_MAX = 88;
const UPLOAD_SIMULATED_RAMP_MS = 12_000;

export function uploadSimulatedCap(elapsedMs: number): number {
  if (elapsedMs <= 0) return 0;
  const ramp = (elapsedMs / UPLOAD_SIMULATED_RAMP_MS) * UPLOAD_SIMULATED_CAP_MAX;
  return Math.min(UPLOAD_SIMULATED_CAP_MAX, ramp);
}

/** Monotonic target for the fill; ignores spurious 0 while a row is already in-flight. */
export function uploadDisplayProgressTarget(
  previous: number,
  incoming: number,
  active: boolean,
): number {
  if (!active) return incoming;
  const clamped = Math.min(100, Math.max(0, incoming));
  if (clamped <= 0 && previous > 0) return previous;
  return Math.max(previous, clamped);
}

/**
 * How fast the visible fill may climb, in percent per millisecond. A full 0→100
 * sweep takes ~0.85s at this rate — slow enough to read as motion, fast enough
 * that a small file that finishes instantly still animates rather than snapping.
 */
export const UPLOAD_DISPLAY_RATE_PCT_PER_MS = 100 / 850;

/**
 * Constant-rate, time-based advance of the fill toward `target`. This is what
 * makes the bar climb LINEARLY: every millisecond moves it the same distance,
 * unlike the old ease-out that lurched fast-then-slow on each bursty XHR event
 * (the "忽涨忽跌" jumpiness). Monotonic — a target that dips below the current
 * fill holds it in place instead of dragging it backwards — and clamped to the
 * target so it never overshoots.
 */
export function uploadLinearStep(
  current: number,
  target: number,
  dtMs: number,
  rate = UPLOAD_DISPLAY_RATE_PCT_PER_MS,
): { next: number; done: boolean } {
  if (target <= current) return { next: current, done: true };
  const advanced = current + rate * Math.max(0, dtMs);
  if (advanced >= target) return { next: target, done: true };
  return { next: advanced, done: false };
}

/**
 * One animation frame of the upload fill: pick the monotonic target (real XHR
 * percent, backstopped by the simulated ramp so a quiet upload still moves),
 * advance the fill toward it at the steady linear rate, and report whether the
 * loop can stop. It only stops once the fill has caught its target AND the input
 * has reached 100 — otherwise the bar would freeze at the 88% ramp cap while the
 * real upload is still finishing.
 */
export function uploadDisplayFrame(
  display: number,
  xhr: number,
  elapsedMs: number,
  dtMs: number,
): { next: number; done: boolean } {
  const incoming = Math.max(xhr, uploadSimulatedCap(elapsedMs));
  const target = uploadDisplayProgressTarget(display, incoming, true);
  const { next, done } = uploadLinearStep(display, target, dtMs);
  return { next, done: done && incoming >= 100 };
}
