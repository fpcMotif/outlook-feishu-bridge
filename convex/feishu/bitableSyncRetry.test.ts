import { describe, expect, it } from "vitest";

import {
  BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS,
  isPermanentBitableSyncError,
  MAX_BITABLE_SYNC_ATTEMPTS,
  planBitableSyncBegin,
  resolveBitableNextRetryAt,
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

describe("planBitableSyncBegin", () => {
  const NOW = 1_000_000;

  it("schedules an immediate worker for a brand-new row and leases it from the cron", () => {
    expect(planBitableSyncBegin(null, NOW)).toEqual({
      shouldSchedule: true,
      nextRetryAt: NOW + BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS,
    });
  });

  it("reschedules a previously-failed row and re-leases it", () => {
    expect(
      planBitableSyncBegin({ bitableSyncStatus: "failed", bitableNextRetryAt: NOW - 999 }, NOW),
    ).toEqual({
      shouldSchedule: true,
      nextRetryAt: NOW + BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS,
    });
  });

  it("does not enqueue a second worker for an in-flight pending row; keeps its lease", () => {
    const leasedUntil = NOW + 30_000;
    expect(
      planBitableSyncBegin({ bitableSyncStatus: "pending", bitableNextRetryAt: leasedUntil }, NOW),
    ).toEqual({ shouldSchedule: false, nextRetryAt: leasedUntil });
  });

  it("defers a pending row with no recorded retry time to a fresh lease", () => {
    expect(planBitableSyncBegin({ bitableSyncStatus: "pending" }, NOW)).toEqual({
      shouldSchedule: false,
      nextRetryAt: NOW + BITABLE_SYNC_FIRST_ATTEMPT_LEASE_MS,
    });
  });
});
