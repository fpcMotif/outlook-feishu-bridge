/* eslint-disable max-lines-per-function */
// Coverage top-up for selfForwardChain.ts. The happy path, URL-encoding, and the
// two primary failure modes are covered in selfForwardChain.test.ts; this file
// exercises the remaining branches:
//   - readError's non-JSON (text) fallback, the text()-throws fallback, and the
//     statusText fallbacks for both string and object error envelopes
//   - acquireAppToken's "200 but no access_token" -> no_access_token result
//   - fail()'s request-id header fallback chain (x-ms-request-id / client-request-id / (none))
//   - forwardOriginalMessage's 202 request-id fallbacks (x-ms-request-id, then undefined)
//
// AAD error shapes per https://learn.microsoft.com/entra/identity-platform/v2-oauth2-client-creds-grant-flow
// Graph message-forward per https://learn.microsoft.com/graph/api/message-forward

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { runSelfForwardChain, type Fetcher } from "./selfForwardChain";

const ENV = {
  tenantId: "93b47f6a-5661-4677-a047-ab4fee1cad47",
  clientId: "2ccb5d91-1bd7-4b62-9c3b-71d115c8af0a",
  clientSecret: "secret-value",
};
const INPUT = {
  originalMessageId: "AAMkADAwMS1hYzNi",
  selfEmail: "fanpc@fenchem.com",
};

function jsonResponse(body: unknown, init: Partial<ResponseInit> = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runSelfForwardChain token-step error parsing", () => {
  it("reads a non-JSON token error body via the text() fallback and codes it HTTP_<status>", async () => {
    // A Response-like whose json() rejects but text() resolves a string body, so
    // readError exercises the `body = await res.text()` fallback path and uses the
    // returned string as the message. (Real undici Responses consume the body on a
    // failed .json(), so we synthesize the object to isolate the text-fallback branch.)
    const proxyErr = {
      ok: false,
      status: 502,
      statusText: "Bad Gateway",
      headers: new Headers(),
      json: () => Promise.reject(new Error("not json")),
      text: () => Promise.resolve("upstream proxy error"),
    } as unknown as Response;
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(proxyErr));
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("token");
      expect(result.code).toBe("HTTP_502");
      expect(result.message).toBe("upstream proxy error");
    }
  });

  it("falls back to res.statusText when a non-JSON token error body is empty", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        // Empty text body -> `body || res.statusText`. jsdom Response exposes
        // statusText, so an empty body surfaces the status reason phrase.
        new Response("", { status: 503, statusText: "Service Unavailable" }),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HTTP_503");
      expect(result.message).toBe("Service Unavailable");
    }
  });

  it("falls back to '' when both json() and text() throw on the token error response", async () => {
    // Synthesize a Response-like object whose json() AND text() both reject, so
    // readError lands on `body = ""` and then `body || res.statusText`.
    const broken = {
      ok: false,
      status: 500,
      statusText: "",
      headers: new Headers(),
      json: () => Promise.reject(new Error("no json")),
      text: () => Promise.reject(new Error("no text")),
    } as unknown as Response;
    const fetcher = vi.fn<Fetcher>(() => Promise.resolve(broken));
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("token");
      expect(result.code).toBe("HTTP_500");
      // empty body AND empty statusText -> message is ""
      expect(result.message).toBe("");
    }
  });

  it("uses res.statusText when a string-error envelope omits error_description", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant" },
          { status: 400, statusText: "Bad Request" },
        ),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("invalid_grant");
      expect(result.message).toBe("Bad Request");
    }
  });

  it("codes an object-error envelope lacking code/message via HTTP_<status>+statusText", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        // error is an object but neither code nor message is set.
        jsonResponse({ error: {} }, { status: 418, statusText: "I'm a teapot" }),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HTTP_418");
      expect(result.message).toBe("I'm a teapot");
    }
  });

  it("codes a missing-error envelope (no `error` key) via HTTP_<status>", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        // No `error` field at all -> `body.error ?? {}` -> {} -> HTTP fallback.
        jsonResponse({ something: "else" }, { status: 401, statusText: "Unauthorized" }),
      ),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("HTTP_401");
      expect(result.message).toBe("Unauthorized");
    }
  });
});

describe("acquireAppToken no_access_token branch", () => {
  it("returns step=token code=no_access_token when a 200 token response omits access_token", async () => {
    const fetcher = vi.fn<Fetcher>(() =>
      // res.ok but the JSON has no access_token (e.g. unexpected envelope).
      Promise.resolve(jsonResponse({ token_type: "Bearer", expires_in: 3599 })),
    );
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.step).toBe("token");
      expect(result.code).toBe("no_access_token");
      expect(result.message).toBe(
        "client_credentials succeeded but returned no access_token",
      );
    }
    // Only the token call ran; the forward never fired.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("fail() request-id header fallback chain", () => {
  it("logs ms-request-id from request-id when present on a forward failure", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) return Promise.resolve(jsonResponse({ access_token: "g" }));
      return Promise.resolve(
        jsonResponse(
          { error: { code: "ErrorAccessDenied", message: "Denied" } },
          { status: 403, headers: { "request-id": "rid-primary" } },
        ),
      );
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("ms-request-id=rid-primary"),
    );
  });

  it("falls back to x-ms-request-id, then client-request-id for the failure log", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // First failure: only x-ms-request-id present.
    const f1 = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "E", message: "m" } },
          { status: 400, headers: { "x-ms-request-id": "rid-xms" } },
        ),
      ),
    );
    await runSelfForwardChain(INPUT, ENV, f1);
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("ms-request-id=rid-xms"),
    );

    // Second failure: only client-request-id present.
    const f2 = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse(
          { error: { code: "E", message: "m" } },
          { status: 400, headers: { "client-request-id": "rid-client" } },
        ),
      ),
    );
    await runSelfForwardChain(INPUT, ENV, f2);
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("ms-request-id=rid-client"),
    );
  });

  it("logs ms-request-id=(none) when no request-id headers are present", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetcher = vi.fn<Fetcher>(() =>
      Promise.resolve(
        jsonResponse({ error: { code: "E", message: "m" } }, { status: 400 }),
      ),
    );
    await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(errorSpy).toHaveBeenLastCalledWith(
      expect.stringContaining("ms-request-id=(none)"),
    );
  });
});

describe("forwardOriginalMessage 202 request-id fallbacks", () => {
  it("returns requestId from request-id when the 202 carries it", async () => {
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) return Promise.resolve(jsonResponse({ access_token: "g" }));
      return Promise.resolve(
        new Response(null, { status: 202, headers: { "request-id": "fr-1" } }),
      );
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result).toEqual({ ok: true, requestId: "fr-1" });
  });

  it("falls back to x-ms-request-id for the 202 requestId when request-id is absent", async () => {
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) return Promise.resolve(jsonResponse({ access_token: "g" }));
      return Promise.resolve(
        new Response(null, { status: 202, headers: { "x-ms-request-id": "fr-xms" } }),
      );
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result).toEqual({ ok: true, requestId: "fr-xms" });
  });

  it("returns requestId undefined when a 202 carries no request-id headers", async () => {
    let n = 0;
    const fetcher = vi.fn<Fetcher>(() => {
      n += 1;
      if (n === 1) return Promise.resolve(jsonResponse({ access_token: "g" }));
      return Promise.resolve(new Response(null, { status: 202 }));
    });
    const result = await runSelfForwardChain(INPUT, ENV, fetcher);
    expect(result).toEqual({ ok: true, requestId: undefined });
  });
});
