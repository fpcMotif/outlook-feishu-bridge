/* eslint-disable require-await, max-lines-per-function */
// Behavioral lock for the fused callFeishu pipeline (ADR-0030). Plain vitest
// (ADR-0019): token resolvers are module-mocked, fetch is a mocked global —
// no Convex runtime. Locks the semantics the bitable.ts call sites moved onto
// `retry: true`: the token is re-resolved on every retry attempt (exactly like
// the old call-site `withFeishuRateLimitRetry(() => callFeishu(…))` wrap), a
// blown call budget is never replayed in-process, and error instances cross
// the Promise boundary unchanged.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ActionCtx } from "../_generated/server";
import { callFeishu, FEISHU_TOO_MANY_REQUEST_CODE } from "./call";
import { FeishuError, FeishuTimeoutError } from "./client";

const mocks = vi.hoisted(() => ({
  getTenantAccessToken: vi.fn<() => Promise<string>>(),
  getUserAccessToken: vi.fn<() => Promise<string>>(),
}));
vi.mock("./auth", () => ({
  getTenantAccessToken: mocks.getTenantAccessToken,
}));
vi.mock("./userAuth", () => ({
  getUserAccessToken: mocks.getUserAccessToken,
}));

const ctx = {} as unknown as ActionCtx;
const noSleep = () => vi.fn((_ms: number) => Promise.resolve());

function mockFetchEnvelopes(...payloads: unknown[]) {
  const fn = vi.fn();
  for (const payload of payloads) {
    fn.mockImplementationOnce(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      status: 200,
      headers: new Headers(),
      text: async () => JSON.stringify(payload),
    }));
  }
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("callFeishu fused pipeline (Effect v4, ADR-0030)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
    mocks.getTenantAccessToken.mockReset().mockResolvedValue("TENANT");
    mocks.getUserAccessToken.mockReset().mockResolvedValue("USER");
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the inner data payload on success", async () => {
    mockFetchEnvelopes({ code: 0, msg: "ok", data: { record: { record_id: "rec1" } } });
    await expect(
      callFeishu<{ record?: { record_id: string } }>(ctx, {
        path: "/bitable/v1/x",
        auth: "tenant",
        label: "T",
      }),
    ).resolves.toMatchObject({ record: { record_id: "rec1" } });
    expect(mocks.getTenantAccessToken).toHaveBeenCalledTimes(1);
  });

  it("retry: true replays a throttle AND re-resolves the token per attempt", async () => {
    const sleep = noSleep();
    const fn = mockFetchEnvelopes(
      { code: FEISHU_TOO_MANY_REQUEST_CODE, msg: "busy" },
      { code: 0, msg: "ok", data: { v: 1 } },
    );
    await expect(
      callFeishu<{ v: number }>(ctx, {
        path: "/x",
        auth: "tenant",
        label: "T",
        retry: { sleep },
      }),
    ).resolves.toEqual({ v: 1 });
    expect(fn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    // The old call-site wrap re-ran ALL of callFeishu per attempt — keep that:
    // a retried attempt must never reuse a possibly-stale token.
    expect(mocks.getTenantAccessToken).toHaveBeenCalledTimes(2);
  });

  it("a pre-resolved token is reused and the resolver is never consulted", async () => {
    mockFetchEnvelopes({ code: 0, msg: "ok", data: { v: 1 } });
    await callFeishu(ctx, { path: "/x", auth: "tenant", token: "PREB", label: "T" });
    expect(mocks.getTenantAccessToken).not.toHaveBeenCalled();
  });

  it("retry: true does NOT replay a non-rate-limit FeishuError", async () => {
    const sleep = noSleep();
    const fn = mockFetchEnvelopes({ code: 1254045, msg: "FieldNameNotFound" });
    await expect(
      callFeishu(ctx, { path: "/x", auth: "tenant", label: "T", retry: { sleep } }),
    ).rejects.toMatchObject({ name: "FeishuError", code: 1254045 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retry: true does NOT replay a blown call budget (fail fast to durable layers)", async () => {
    const sleep = noSleep();
    const fn = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new Error("aborted by signal"));
          });
        }),
    );
    globalThis.fetch = fn as unknown as typeof fetch;
    const err = await callFeishu(ctx, {
      path: "/x",
      auth: "tenant",
      label: "Slow",
      timeoutMs: 15,
      retry: { sleep },
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeishuTimeoutError);
    expect(fn).toHaveBeenCalledTimes(1); // one attempt, no in-process replay
    expect(sleep).not.toHaveBeenCalled();
  });

  it("rejects with Error when the envelope succeeds without data", async () => {
    mockFetchEnvelopes({ code: 0, msg: "ok" });
    await expect(
      callFeishu(ctx, { path: "/x", auth: "tenant", label: "T" }),
    ).rejects.toThrow("T succeeded but returned no data");
  });

  it("user auth without sessionId rejects with the original guard Error", async () => {
    mockFetchEnvelopes({ code: 0, msg: "ok", data: {} });
    await expect(
      callFeishu(ctx, { path: "/x", auth: "user", label: "T" }),
    ).rejects.toThrow("sessionId is required for user-authenticated Feishu calls");
    expect(mocks.getUserAccessToken).not.toHaveBeenCalled();
  });

  it("a FeishuError thrown by TOKEN resolution is retried under retry: true", async () => {
    const sleep = noSleep();
    mocks.getTenantAccessToken
      .mockReset()
      .mockRejectedValueOnce(
        new FeishuError(FEISHU_TOO_MANY_REQUEST_CODE, "token throttle", "Feishu auth"),
      )
      .mockResolvedValueOnce("TENANT");
    const fn = mockFetchEnvelopes({ code: 0, msg: "ok", data: { v: 2 } });
    await expect(
      callFeishu<{ v: number }>(ctx, { path: "/x", auth: "tenant", label: "T", retry: { sleep } }),
    ).resolves.toEqual({ v: 2 });
    expect(mocks.getTenantAccessToken).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenCalledTimes(1); // fetch only ran on the successful attempt
  });
});
