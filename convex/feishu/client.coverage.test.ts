/* eslint-disable require-await, max-lines-per-function */
// Coverage top-up for client.ts. The sibling client.test.ts already asserts the
// happy path, the FeishuError-on-nonzero path, the StatusCode tolerance, and the
// header/body shaping. The gaps left there are:
//   - the non-JSON-response catch branch (client.ts:72-77)
//   - the X-Tt-Logid fallback chain in the failure log (client.ts:85-89)
//   - the default-to-POST method (client.ts:63)
// All exercised here against a mocked globalThis.fetch.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { feishuFetch, FeishuError } from "./client";

/** Fake fetch whose body text is whatever the caller supplies (not JSON-encoded
 * for us) so we can drive the JSON.parse catch branch with a non-JSON body. */
function mockFetchRaw(
  rawText: string,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  const fn = vi.fn(
    async (_input: RequestInfo | URL, _init?: RequestInit) =>
      ({
        status: init.status ?? 200,
        headers: new Headers(init.headers ?? {}),
        text: async () => rawText,
        json: async () => JSON.parse(rawText),
      }) as Response,
  );
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

function mockFetchJson(
  payload: unknown,
  init: { status?: number; headers?: Record<string, string> } = {},
) {
  return mockFetchRaw(JSON.stringify(payload), init);
}

describe("feishuFetch — non-JSON response branch (client.ts:72-77)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws FeishuError(-1, 'non-JSON response (status=...)') when the body is not JSON", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A 502 HTML error page is the classic non-JSON body from an upstream proxy.
    mockFetchRaw("<html>502 Bad Gateway</html>", { status: 502 });

    await expect(
      feishuFetch({ url: "https://x/y", label: "Bitable create" }),
    ).rejects.toMatchObject({
      name: "FeishuError",
      code: -1,
      feishuMsg: "non-JSON response (status=502)",
    });
    // It logs the raw body for triage before throwing.
    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(String(errSpy.mock.calls[0][0])).toContain("non-JSON response (status=502)");
    expect(String(errSpy.mock.calls[0][0])).toContain("Bitable create");
  });

  it("uses the 'Feishu API' default label in the non-JSON error when no label is supplied", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchRaw("not json at all", { status: 500 });

    await expect(feishuFetch({ url: "https://x/y" })).rejects.toMatchObject({
      name: "FeishuError",
      code: -1,
    });
  });
});

describe("feishuFetch — failure log id fallback chain (client.ts:85-89)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reads X-Tt-Logid from the response headers in the failure log", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchJson(
      { code: 99991663, msg: "token invalid" },
      { headers: { "X-Tt-Logid": "log-abc-123" } },
    );

    await expect(
      feishuFetch({ url: "https://x/y", label: "Auth" }),
    ).rejects.toBeInstanceOf(FeishuError);
    expect(String(errSpy.mock.calls[0][0])).toContain("logId=log-abc-123");
  });

  it("falls back to X-Request-Id when no X-Tt-Logid header is present", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchJson(
      { code: 1254005, msg: "bad" },
      { headers: { "X-Request-Id": "req-xyz" } },
    );

    await expect(feishuFetch({ url: "https://x/y" })).rejects.toBeInstanceOf(FeishuError);
    expect(String(errSpy.mock.calls[0][0])).toContain("logId=req-xyz");
  });

  it("falls back to '(none)' when no log-id header of any kind is present", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetchJson({ code: 42, msg: "nope" });

    await expect(feishuFetch({ url: "https://x/y" })).rejects.toBeInstanceOf(FeishuError);
    expect(String(errSpy.mock.calls[0][0])).toContain("logId=(none)");
  });
});

describe("feishuFetch — method defaulting (client.ts:63)", () => {
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = realFetch;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("defaults the HTTP method to POST when opts.method is omitted", async () => {
    const fn = mockFetchJson({ code: 0, msg: "ok" });
    await feishuFetch({ url: "https://x/y" });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
  });

  it("uses opts.method verbatim when provided (GET)", async () => {
    const fn = mockFetchJson({ code: 0, msg: "ok" });
    await feishuFetch({ url: "https://x/y", method: "GET" });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("GET");
  });
});
