/* eslint-disable require-await, max-lines-per-function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { feishuFetch, FeishuError } from "./client";

function mockFetch(payload: unknown) {
  const fn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({ json: async () => payload }) as Response,
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe("feishuFetch", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns the parsed envelope on code 0", async () => {
    mockFetch({ code: 0, msg: "ok", data: { file_key: "abc" } });
    const res = await feishuFetch<{ data?: { file_key: string } }>({
      url: "https://x/y",
    });
    expect(res.data?.file_key).toBe("abc");
  });

  it("throws FeishuError carrying the code on non-zero code", async () => {
    mockFetch({ code: 99991663, msg: "token invalid" });
    await expect(feishuFetch({ url: "https://x/y", label: "Test" })).rejects.toMatchObject({
      name: "FeishuError",
      code: 99991663,
      feishuMsg: "token invalid",
    });
  });

  it("tolerates StatusCode 0 only when acceptStatusCode is set", async () => {
    mockFetch({ code: 19001, StatusCode: 0, msg: "x" });
    await expect(
      feishuFetch({ url: "https://x/y", acceptStatusCode: true }),
    ).resolves.toBeTruthy();

    mockFetch({ code: 19001, StatusCode: 0, msg: "x" });
    await expect(feishuFetch({ url: "https://x/y" })).rejects.toBeInstanceOf(FeishuError);
  });

  it("sets the bearer header when a token is given", async () => {
    const fn = mockFetch({ code: 0, msg: "ok" });
    await feishuFetch({ url: "https://x/y", token: "T0KEN" });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer T0KEN");
  });

  it("JSON-encodes a json body and sets Content-Type", async () => {
    const fn = mockFetch({ code: 0, msg: "ok" });
    await feishuFetch({ url: "https://x/y", json: { a: 1 } });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ a: 1 }));
  });

  it("passes a FormData body through without a Content-Type header", async () => {
    const fn = mockFetch({ code: 0, msg: "ok" });
    const form = new FormData();
    form.append("k", "v");
    await feishuFetch({ url: "https://x/y", form });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.body).toBe(form);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });
});
