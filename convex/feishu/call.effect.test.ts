/* eslint-disable max-lines-per-function */
// Behavioral lock for the Effect v4 retry pilot (ADR-0029). These run in plain
// vitest at the Effect boundary (ADR-0019) — no Convex runtime — by injecting
// `fn` and a fake `sleep`, so they assert exactly the contract the live path
// (callFeishu / bitable.ts) and the attachmentFill suite already depend on:
// retry only rate-limit codes, honor the server hint, and rethrow the ORIGINAL
// error object unchanged.
import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import {
  FEISHU_TOO_MANY_REQUEST_CODE,
  FEISHU_DUPLICATE_REQUEST_CODE,
  FEISHU_RATE_LIMIT_CODE,
  withFeishuRateLimitRetry,
  withFeishuRateLimitRetryEffect,
} from "./call";
import { FeishuError } from "./client";

// A sleep that never touches a real timer; we still assert what it was asked to wait.
const fakeSleep = () => vi.fn((_ms: number) => Promise.resolve());

describe("withFeishuRateLimitRetryEffect (Effect v4 pilot, ADR-0029)", () => {
  it("retries a throttle, honoring the server retryAfterMs hint, then succeeds", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new FeishuError(FEISHU_TOO_MANY_REQUEST_CODE, "busy", "Feishu API", 25),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      Effect.runPromise(withFeishuRateLimitRetryEffect(fn, { sleep })),
    ).resolves.toBe("ok");

    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(25); // the hint won over the backoff
  });

  it("falls back to exponential backoff when there is no hint", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(
        new FeishuError(FEISHU_RATE_LIMIT_CODE, "slow down", "Feishu API"),
      )
      .mockResolvedValueOnce("ok");

    await expect(
      Effect.runPromise(
        withFeishuRateLimitRetryEffect(fn, { sleep, backoffMs: (n) => 10 * 2 ** n }),
      ),
    ).resolves.toBe("ok");

    expect(sleep).toHaveBeenCalledWith(10); // backoffMs(0)
  });

  it("retries the in-flight-dedup code (1254608) as well", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(
        new FeishuError(FEISHU_DUPLICATE_REQUEST_CODE, "dupe", "Feishu API"),
      )
      .mockResolvedValueOnce(7);

    await expect(
      Effect.runPromise(withFeishuRateLimitRetryEffect(fn, { sleep })),
    ).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-rate-limit FeishuError", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new FeishuError(42, "bad request", "Feishu API"));

    await expect(
      Effect.runPromise(withFeishuRateLimitRetryEffect(fn, { sleep })),
    ).rejects.toBeInstanceOf(FeishuError);

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does NOT retry a non-FeishuError (e.g. a transport failure)", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(new Error("network down"));

    await expect(
      Effect.runPromise(withFeishuRateLimitRetryEffect(fn, { sleep })),
    ).rejects.toThrow("network down");

    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("gives up after maxAttempts and rejects with the last throttle error", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new FeishuError(FEISHU_TOO_MANY_REQUEST_CODE, "still busy", "Feishu API"),
      );

    await expect(
      Effect.runPromise(withFeishuRateLimitRetryEffect(fn, { sleep, maxAttempts: 3 })),
    ).rejects.toBeInstanceOf(FeishuError);

    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
    expect(sleep).toHaveBeenCalledTimes(2);
  });
});

describe("withFeishuRateLimitRetry (Promise boundary)", () => {
  it("rejects with the ORIGINAL FeishuError instance (Cause.squash preserves identity)", async () => {
    const sleep = fakeSleep();
    const original = new FeishuError(7777, "nope", "Feishu API");
    const fn = vi.fn<() => Promise<string>>().mockRejectedValue(original);

    // Callers do `instanceof FeishuError` / read `.code`, so Effect.runPromise
    // must surface the very same object it was given — not a wrapped FiberFailure.
    await expect(withFeishuRateLimitRetry(fn, { sleep })).rejects.toBe(original);
  });

  it("defaults to 4 attempts (3 retries) on a persistent throttle", async () => {
    const sleep = fakeSleep();
    const fn = vi
      .fn<() => Promise<string>>()
      .mockRejectedValue(
        new FeishuError(FEISHU_TOO_MANY_REQUEST_CODE, "busy", "Feishu API"),
      );

    await expect(withFeishuRateLimitRetry(fn, { sleep })).rejects.toBeInstanceOf(
      FeishuError,
    );
    expect(fn).toHaveBeenCalledTimes(4);
    expect(sleep).toHaveBeenCalledTimes(3);
  });

  it("resolves with the value on first success, with no sleep", async () => {
    const sleep = fakeSleep();
    const fn = vi.fn<() => Promise<string>>().mockResolvedValue("done");

    await expect(withFeishuRateLimitRetry(fn, { sleep })).resolves.toBe("done");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
