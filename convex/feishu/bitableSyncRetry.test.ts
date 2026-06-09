import { describe, expect, it } from "vitest";

import {
  BITABLE_NEXT_RETRY_MIN,
  isBitableSyncDue,
  isPermanentBitableSyncError,
  MAX_BITABLE_SYNC_ATTEMPTS,
  planBitableSyncFailure,
  resolveBitableNextRetryAt,
  shouldRearmStaleSync,
  STALE_PENDING_REARM_GRACE_MS,
} from "./bitableSyncRetry";

describe("bitableSyncRetry", () => {
  it("treats UserFieldConvFail as permanent", () => {
    expect(
      isPermanentBitableSyncError(
        "Uncaught FeishuError: Bitable create service row failed (code 1254066): UserFieldConvFail",
      ),
    ).toBe(true);
  });

  it("treats abandoned outbox rows as permanent", () => {
    expect(isPermanentBitableSyncError("Abandoned: browser dev-sample mail must not sync to Feishu Base.")).toBe(
      true,
    );
  });

  it("stops scheduling after max attempts", () => {
    expect(
      resolveBitableNextRetryAt(MAX_BITABLE_SYNC_ATTEMPTS, 1_000, "transient timeout"),
    ).toBeUndefined();
  });

  it("schedules backoff for transient errors under the cap", () => {
    expect(resolveBitableNextRetryAt(1, 1_000, "timeout")).toBe(1_000 + 5 * 60_000);
  });
});

describe("isBitableSyncDue", () => {
  it("never treats the undefined sentinel as due", () => {
    // The "never retry again" sentinel is a missing bitableNextRetryAt. It must
    // stay out of the reconcile sweep no matter how far the clock advances,
    // even though it sorts below all numbers in the Convex index range.
    expect(isBitableSyncDue(undefined, Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("is due once a real retry time has been reached", () => {
    expect(isBitableSyncDue(1_000, 1_000)).toBe(true); // exactly now (inclusive)
    expect(isBitableSyncDue(1_000, 5_000)).toBe(true); // in the past
  });

  it("is not due while the retry time is still in the future", () => {
    expect(isBitableSyncDue(5_000, 1_000)).toBe(false);
  });

  it("excludes values below the index lower bound", () => {
    expect(BITABLE_NEXT_RETRY_MIN).toBe(0);
    expect(isBitableSyncDue(BITABLE_NEXT_RETRY_MIN - 1, 10_000)).toBe(false);
  });

  it("excludes a maxed-out row whose next-retry resolved to the sentinel", () => {
    // End-to-end of the bug: a row that exhausts MAX_BITABLE_SYNC_ATTEMPTS has
    // its next-retry cleared to undefined, and the due-check then keeps it out
    // of the sweep — so the reconcile cron no longer retries it forever.
    const now = 10_000;
    const nextRetryAt = resolveBitableNextRetryAt(
      MAX_BITABLE_SYNC_ATTEMPTS,
      now,
      "transient timeout",
    );
    expect(nextRetryAt).toBeUndefined();
    expect(isBitableSyncDue(nextRetryAt, now)).toBe(false);
  });
});

describe("planBitableSyncFailure", () => {
  it("schedules a bounded retry for a transient failure under the cap", () => {
    // attemptCount is the count AFTER this failure is recorded; attempt 1 maps to
    // the 5-minute first backoff, and the action schedules itself that far out.
    expect(planBitableSyncFailure(1, 1_000, "timeout")).toEqual({
      status: "failed",
      nextRetryAt: 1_000 + 5 * 60_000,
      retryDelayMs: 5 * 60_000,
    });
  });

  it("widens the backoff on the second attempt", () => {
    expect(planBitableSyncFailure(2, 1_000, "timeout")).toEqual({
      status: "failed",
      nextRetryAt: 1_000 + 15 * 60_000,
      retryDelayMs: 15 * 60_000,
    });
  });

  it("retires the task as abandoned once attempts reach the cap", () => {
    // The replacement for the perpetual sweep: at MAX attempts the row goes
    // terminal — no delay means the per-task chain stops enqueuing itself.
    expect(planBitableSyncFailure(MAX_BITABLE_SYNC_ATTEMPTS, 1_000, "transient timeout")).toEqual({
      status: "abandoned",
      nextRetryAt: undefined,
      retryDelayMs: undefined,
    });
  });

  it("retires the task as abandoned on a permanent error, regardless of attempt", () => {
    expect(
      planBitableSyncFailure(1, 1_000, "Abandoned: browser dev-sample mail must not sync to Feishu Base."),
    ).toEqual({
      status: "abandoned",
      nextRetryAt: undefined,
      retryDelayMs: undefined,
    });
  });
});

describe("shouldRearmStaleSync", () => {
  const now = 1_000_000;

  it("re-arms a pending task whose retry time went stale with no live job", () => {
    // Cases 2 & 3: the per-task chain never re-fired (action died, or the
    // success-mark threw), so the row sits pending well past its retry time.
    expect(
      shouldRearmStaleSync(
        { bitableSyncStatus: "pending", bitableNextRetryAt: now - STALE_PENDING_REARM_GRACE_MS - 1 },
        now,
      ),
    ).toBe(true);
  });

  it("re-arms a failed task whose scheduled chain link was lost", () => {
    expect(
      shouldRearmStaleSync(
        { bitableSyncStatus: "failed", bitableNextRetryAt: now - STALE_PENDING_REARM_GRACE_MS - 1 },
        now,
      ),
    ).toBe(true);
  });

  it("leaves a freshly-scheduled attempt alone inside the grace window", () => {
    // First attempt rides runAfter(0); reopening immediately must not race it.
    expect(
      shouldRearmStaleSync({ bitableSyncStatus: "pending", bitableNextRetryAt: now }, now),
    ).toBe(false);
  });

  it("does not re-arm while a chain retry is still in the future", () => {
    expect(
      shouldRearmStaleSync({ bitableSyncStatus: "failed", bitableNextRetryAt: now + 5 * 60_000 }, now),
    ).toBe(false);
  });

  it("never re-arms a terminal abandoned task", () => {
    expect(
      shouldRearmStaleSync(
        { bitableSyncStatus: "abandoned", bitableNextRetryAt: now - 10 * 60_000 },
        now,
      ),
    ).toBe(false);
  });

  it("never re-arms a task already linked to a Base row", () => {
    expect(
      shouldRearmStaleSync(
        {
          bitableSyncStatus: "pending",
          bitableRecordId: "rec_done",
          bitableNextRetryAt: now - 10 * 60_000,
        },
        now,
      ),
    ).toBe(false);
  });

  it("never re-arms the undefined next-retry sentinel", () => {
    expect(
      shouldRearmStaleSync({ bitableSyncStatus: "failed", bitableNextRetryAt: undefined }, now),
    ).toBe(false);
  });
});
