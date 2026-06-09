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

export type BitableSyncFailureStatus = "failed" | "abandoned";

export interface BitableSyncFailurePlan {
  /** `failed` while retries remain; `abandoned` once the row is terminal. */
  status: BitableSyncFailureStatus;
  /** Real epoch-ms next-retry time, or undefined (the "never again" sentinel). */
  nextRetryAt: number | undefined;
  /** Delay to schedule the next self-retry, or undefined when terminal. */
  retryDelayMs: number | undefined;
}

/**
 * Decide what to do after a Bitable sync attempt fails, given the post-increment
 * `attemptCount`. This is the single source of truth shared by the failure
 * mutation (which persists `status` + `nextRetryAt`) and the action (which uses
 * `retryDelayMs` to schedule the next per-task self-retry). When the next retry
 * resolves to the undefined sentinel — permanent error or MAX attempts reached —
 * the row is terminal: status `abandoned`, no delay, so the chain stops enqueuing.
 */
export function planBitableSyncFailure(
  attemptCount: number,
  attemptedAt: number,
  error: string,
): BitableSyncFailurePlan {
  const resolvedNextRetryAt = resolveBitableNextRetryAt(attemptCount, attemptedAt, error);
  if (resolvedNextRetryAt === undefined) {
    return { status: "abandoned", nextRetryAt: undefined, retryDelayMs: undefined };
  }
  return {
    status: "failed",
    nextRetryAt: resolvedNextRetryAt,
    retryDelayMs: resolvedNextRetryAt - attemptedAt,
  };
}

/**
 * Lower bound for the `bitableNextRetryAt` index range used to find due rows.
 *
 * `bitableNextRetryAt` is `v.optional(v.number())`: an absent value is the
 * "never retry again" sentinel set once a row is succeeded, abandoned, or has
 * exhausted MAX_BITABLE_SYNC_ATTEMPTS (see {@link resolveBitableNextRetryAt}).
 * In a Convex index a missing field sorts BELOW every number, so a bare
 * `.lte("bitableNextRetryAt", now)` range also matches those sentinel rows and
 * re-selects them on every reconcile pass — defeating the attempt cap. Real
 * retry times are always positive epoch-ms, so bounding the range below by 0
 * keeps the sentinel rows out of the sweep.
 */
export const BITABLE_NEXT_RETRY_MIN = 0;

/**
 * Is a row genuinely due for a Bitable sync retry at `now`? True only when it
 * carries a real (non-sentinel) numeric next-retry time that has already
 * passed. Mirrors the `[BITABLE_NEXT_RETRY_MIN, now]` index range applied in
 * `listDueBitableSyncRecords`, so the same decision stays unit-testable without
 * a live Convex index.
 */
export function isBitableSyncDue(
  retryAt: number | undefined,
  now: number,
): boolean {
  return (
    retryAt !== undefined &&
    retryAt >= BITABLE_NEXT_RETRY_MIN &&
    retryAt <= now
  );
}

/**
 * Grace window before a stale `pending`/`failed` task is re-armed on reopen.
 *
 * A row's first attempt rides `runAfter(0)` and resolves in well under a second;
 * chain retries set a *future* `bitableNextRetryAt`, so a row only looks "overdue"
 * once its scheduled job should already have fired. The grace keeps the self-heal
 * from racing a legitimately in-flight attempt (a slow Feishu create) — only a
 * genuinely stranded job (action died, or the success-mark threw) lingers past it.
 */
export const STALE_PENDING_REARM_GRACE_MS = 2 * 60_000;

/**
 * Should reopening a request re-arm its Bitable sync? True only for a
 * non-terminal task (`pending`/`failed`, not yet linked to a Base row) whose real
 * next-retry time is overdue by more than the grace window — i.e. a stranded job
 * the per-task chain never re-fired. `synced`/`abandoned` rows and the undefined
 * sentinel are never re-armed. This is the cron-free backstop for the rare
 * action-died / mark-threw strands, keyed on the task the taskpane is observing.
 */
export function shouldRearmStaleSync(
  row: {
    bitableSyncStatus?: string;
    bitableRecordId?: string;
    bitableNextRetryAt?: number;
  },
  now: number,
  graceMs: number = STALE_PENDING_REARM_GRACE_MS,
): boolean {
  if (row.bitableRecordId) return false;
  if (row.bitableSyncStatus !== "pending" && row.bitableSyncStatus !== "failed") return false;
  return isBitableSyncDue(row.bitableNextRetryAt, now - graceMs);
}
