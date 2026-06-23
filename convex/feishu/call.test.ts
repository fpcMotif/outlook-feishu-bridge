// Retry-policy unit tests for the Feishu call layer (ADR-0019 extract-then-test).
// This is the single home for the rate-limit classifier + the exponential-backoff
// retry wrapper that BOTH the Bitable record path and the Drive upload path share
// (the Drive wrapper used to re-implement this — see drive.ts history). `sleep` is
// injectable so the policy is asserted without real waits; no Convex ctx is needed.
import { describe, expect, it, vi } from "vitest";

import {
  FEISHU_DUPLICATE_REQUEST_CODE,
  FEISHU_RATE_LIMIT_CODE,
  FEISHU_TOO_MANY_REQUEST_CODE,
  isFeishuRateLimited,
  withFeishuRateLimitRetry,
} from "./call";
import { FeishuError } from "./client";

const rateLimit = (retryAfterMs?: number): FeishuError =>
  new FeishuError(FEISHU_RATE_LIMIT_CODE, "request trigger frequency limit", "Feishu", retryAfterMs);

const noSleep = (): Promise<void> => Promise.resolve();

describe("isFeishuRateLimited", () => {
  it("is true for all three retryable codes (the unified policy)", () => {
    for (const code of [
      FEISHU_TOO_MANY_REQUEST_CODE,
      FEISHU_DUPLICATE_REQUEST_CODE,
      FEISHU_RATE_LIMIT_CODE,
    ]) {
      expect(isFeishuRateLimited(new FeishuError(code, "msg", "Feishu"))).toBe(true);
    }
  });

  it("is false for a non-rate-limit Feishu error (e.g. FieldNameNotFound)", () => {
    expect(isFeishuRateLimited(new FeishuError(1254045, "FieldNameNotFound", "Feishu"))).toBe(false);
  });

  it("is false for a generic Error and for non-error values", () => {
    expect(isFeishuRateLimited(new Error("network down"))).toBe(false);
    expect(isFeishuRateLimited("nope")).toBe(false);
    expect(isFeishuRateLimited(null)).toBe(false);
  });
});

describe("withFeishuRateLimitRetry", () => {
  it("returns immediately on success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    await expect(withFeishuRateLimitRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limit error then succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue("ok");
    await expect(withFeishuRateLimitRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("retries the in-flight-dedup code (1254608) too", async () => {
    const dup = new FeishuError(FEISHU_DUPLICATE_REQUEST_CODE, "still in flight", "Bitable");
    const fn = vi.fn().mockRejectedValueOnce(dup).mockResolvedValue("ok");
    await expect(withFeishuRateLimitRetry(fn, { sleep: noSleep })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("gives up after maxAttempts and rethrows the rate-limit error", async () => {
    const err = rateLimit();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(
      withFeishuRateLimitRetry(fn, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-rate-limit Feishu error", async () => {
    const err = new FeishuError(1254045, "FieldNameNotFound", "Bitable");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withFeishuRateLimitRetry(fn, { sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a generic (non-Feishu) Error", async () => {
    const err = new Error("network down");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(withFeishuRateLimitRetry(fn, { sleep: noSleep })).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("honors the server reset hint over the blind backoff when present", async () => {
    const sleeps: number[] = [];
    const fn = vi.fn().mockRejectedValueOnce(rateLimit(1234)).mockResolvedValue("ok");
    await withFeishuRateLimitRetry(fn, {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoffMs: () => 9999,
    });
    expect(sleeps).toEqual([1234]);
  });

  it("feeds the attempt index to backoffMs", async () => {
    const backoffMs = vi.fn((attempt: number) => attempt);
    const fn = vi.fn().mockRejectedValueOnce(rateLimit()).mockResolvedValue("ok");
    await withFeishuRateLimitRetry(fn, { sleep: noSleep, backoffMs });
    expect(backoffMs).toHaveBeenCalledWith(0);
  });

  it("uses the real backoff sleep between retries (smoke)", async () => {
    const fn = vi.fn().mockRejectedValueOnce(rateLimit()).mockResolvedValue("ok");
    await expect(withFeishuRateLimitRetry(fn, { backoffMs: () => 1 })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});
