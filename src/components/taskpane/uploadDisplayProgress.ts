/** Simulated byte progress while XHR is quiet (caps below real upload %). */
export const UPLOAD_SIMULATED_CAP_MAX = 88;
export const UPLOAD_SIMULATED_RAMP_MS = 12_000;

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

export function uploadSmoothedStep(
  current: number,
  target: number,
  ease = 0.22,
): { next: number; done: boolean } {
  if (target <= current + 0.25) {
    return { next: target, done: true };
  }
  const next = current + (target - current) * ease;
  if (next >= target - 0.4) {
    return { next: target, done: true };
  }
  return { next, done: false };
}
