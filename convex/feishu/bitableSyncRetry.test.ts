import { describe, expect, it } from "vitest";

import {
  isPermanentBitableSyncError,
  MAX_BITABLE_SYNC_ATTEMPTS,
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
