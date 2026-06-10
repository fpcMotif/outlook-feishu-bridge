/* eslint-disable require-await, max-lines-per-function */
// Behavioral lock for the Effect v4 transport (ADR-0030). Plain vitest at the
// Effect boundary (ADR-0019) with a mocked global fetch — no Convex runtime,
// no real Feishu. Locks the contracts callers depend on: the FeishuError `-1`
// non-JSON sentinel (classifyRefreshError), original-instance rethrow for
// unexpected transport failures, and the new bounded call budget surfacing as
// FeishuTimeoutError with the in-flight socket actually aborted.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Effect } from "effect";
import {
  feishuFetch,
  feishuFetchEffect,
  FeishuError,
  FeishuTimeoutError,
  DEFAULT_FEISHU_TIMEOUT_MS,
} from "./client";

function mockFetch(payload: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  const rawText = typeof payload === "string" ? payload : JSON.stringify(payload);
  const fn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        status: init.status ?? 200,
        headers: new Headers(init.headers ?? {}),
        text: async () => rawText,
        json: async () => payload,
      }) as Response,
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** A fetch that never settles until its AbortSignal fires, then rejects. */
function mockHangingFetch() {
  const seen: AbortSignal[] = [];
  const fn = vi.fn(
    (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          seen.push(signal);
          signal.addEventListener("abort", () => {
            reject(new Error("aborted by signal"));
          });
        }
      }),
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return { fn, seen };
}

describe("feishuFetchEffect (Effect v4 transport, ADR-0030)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("succeeds with the parsed envelope on code 0", async () => {
    mockFetch({ code: 0, msg: "ok", data: { file_key: "abc" } });
    await expect(
      Effect.runPromise(
        feishuFetchEffect<{ data?: { file_key: string } }>({ url: "https://x/y" }),
      ),
    ).resolves.toMatchObject({ data: { file_key: "abc" } });
  });

  it("fails in the typed channel with FeishuError on a non-zero code", async () => {
    mockFetch({ code: 99991663, msg: "token invalid" });
    // Effect.flip only converts EXPECTED failures (the error channel) into the
    // success channel — a defect would still reject. This locks "typed, not thrown".
    const err = await Effect.runPromise(
      Effect.flip(feishuFetchEffect({ url: "https://x/y", label: "Test" })),
    );
    expect(err).toBeInstanceOf(FeishuError);
    expect(err).toMatchObject({ code: 99991663, feishuMsg: "token invalid" });
  });

  it("keeps the load-bearing `-1` sentinel for a non-JSON body", async () => {
    mockFetch("<html>bad gateway</html>", { status: 502 });
    await expect(feishuFetch({ url: "https://x/y", label: "T" })).rejects.toMatchObject({
      name: "FeishuError",
      code: -1,
      message: expect.stringContaining("non-JSON response (status=502)"),
    });
  });

  it("still surfaces retryAfterMs from x-ogw-ratelimit-reset on a throttle", async () => {
    mockFetch(
      { code: 99991400, msg: "rate limited" },
      { status: 429, headers: { "x-ogw-ratelimit-reset": "3" } },
    );
    await expect(feishuFetch({ url: "https://x/y", label: "T" })).rejects.toMatchObject({
      name: "FeishuError",
      code: 99991400,
      retryAfterMs: 3000,
    });
  });

  it("passes an AbortSignal to fetch and defaults the budget", async () => {
    const fn = mockFetch({ code: 0, msg: "ok" });
    await feishuFetch({ url: "https://x/y" });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(DEFAULT_FEISHU_TIMEOUT_MS).toBe(30_000);
  });

  it("raises FeishuTimeoutError past the call budget and aborts the socket", async () => {
    const { fn, seen } = mockHangingFetch();
    await expect(
      feishuFetch({ url: "https://x/y", label: "Slow call", timeoutMs: 20 }),
    ).rejects.toMatchObject({
      name: "FeishuTimeoutError",
      timeoutMs: 20,
      message: "Slow call timed out after 20ms",
    });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(seen[0]?.aborted).toBe(true); // the hung exchange was truly torn down
  });

  it("timeout is NOT a FeishuError, so the rate-limit retry will never match it", async () => {
    mockHangingFetch();
    const err = await feishuFetch({ url: "https://x/y", timeoutMs: 10 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeishuTimeoutError);
    expect(err).not.toBeInstanceOf(FeishuError);
  });

  it("rethrows an unexpected transport failure as the ORIGINAL instance (defect path)", async () => {
    const original = new TypeError("fetch failed: network down");
    globalThis.fetch = vi.fn(async () => {
      throw original;
    }) as unknown as typeof fetch;
    await expect(feishuFetch({ url: "https://x/y" })).rejects.toBe(original);
  });
});
