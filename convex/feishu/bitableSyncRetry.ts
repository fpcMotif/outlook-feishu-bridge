export const MAX_BITABLE_SYNC_ATTEMPTS = 5;

// Numeric lower bound for the reconcile "due" index range. A terminal row
// (permanent error / max attempts / poisoned-abandoned) has its
// `bitableNextRetryAt` cleared to undefined — and in a Convex index an
// undefined/absent field sorts BELOW every number, so a bare `.lte(now)` would
// still match it and re-select that dead row every cron cycle forever. Pairing
// `.gte(BITABLE_NEXT_RETRY_MIN)` with `.lte(now)` excludes the unset (terminal)
// rows; real retry timestamps are always positive ms. See listDueBitableSyncRecords.
export const BITABLE_NEXT_RETRY_MIN = 0;

// When syncRequest enqueues a fresh outbox row it also schedules an immediate
// worker (processPendingBitableSync, delay 0). We park `bitableNextRetryAt` this
// far ahead so the 15-minute reconcile cron does NOT also claim the same row
// while that worker is in flight — two workers would create against Feishu in
// parallel and (idempotent client_token aside) race the success mark. The lease
// is much longer than a single create (seconds) yet short enough that a genuinely
// dropped scheduled job is reclaimed by the cron promptly. See ADR-0018.
export const BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS = 2 * 60_000;

export function nextRetryAt(attemptCount: number, attemptedAt: number): number {
  const minutes = attemptCount <= 1 ? 5 : attemptCount === 2 ? 15 : 60;
  return attemptedAt + minutes * 60_000;
}

// The outbox state the begin-sync decision needs (a slice of the Email Record).
export interface BitableSyncBeginState {
  bitableSyncStatus?: "pending" | "synced" | "failed";
  bitableNextRetryAt?: number;
}

export interface BitableSyncBeginPlan {
  /** Schedule an immediate worker for this attempt. */
  shouldSchedule: boolean;
  /** When the reconcile cron may next claim the row (lease-aware). */
  nextRetryAt: number;
}

/**
 * Decide, for an incoming `syncRequest`, whether to schedule an immediate Base
 * create worker and when the reconcile cron may next claim the outbox row.
 *
 * - New row, or a previously-`failed` one we are retrying: a fresh worker runs
 *   now, so lease the first attempt away from the cron (`now + leaseMs`).
 * - Already `pending`: a worker is in flight (or the cron will reclaim at the
 *   existing retry time) — do not enqueue a second worker or re-arm the cron.
 *
 * Pure (no DB) so it is unit-tested; `beginBitableSync` applies the result.
 */
export function planBitableSyncBegin(
  existing: BitableSyncBeginState | null,
  now: number,
  leaseMs: number = BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS,
): BitableSyncBeginPlan {
  if (!existing || existing.bitableSyncStatus === "failed") {
    return { shouldSchedule: true, nextRetryAt: now + leaseMs };
  }
  return { shouldSchedule: false, nextRetryAt: existing.bitableNextRetryAt ?? now + leaseMs };
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
