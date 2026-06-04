export const MAX_BITABLE_SYNC_ATTEMPTS = 5;

export function nextRetryAt(attemptCount: number, attemptedAt: number): number {
  const minutes = attemptCount <= 1 ? 5 : attemptCount === 2 ? 15 : 60;
  return attemptedAt + minutes * 60_000;
}

/** Errors that will not succeed on retry — stop scheduling reconcile replays. */
export function isPermanentBitableSyncError(error: string): boolean {
  if (error.includes("UserFieldConvFail") || error.includes("code 1254066")) return true;
  if (error.includes("dev preview id")) return true;
  if (error.startsWith("Abandoned:")) return true;
  return false;
}

export function resolveBitableNextRetryAt(
  attemptCount: number,
  attemptedAt: number,
  error: string,
): number | undefined {
  if (isPermanentBitableSyncError(error)) return undefined;
  if (attemptCount >= MAX_BITABLE_SYNC_ATTEMPTS) return undefined;
  return nextRetryAt(attemptCount, attemptedAt);
}
