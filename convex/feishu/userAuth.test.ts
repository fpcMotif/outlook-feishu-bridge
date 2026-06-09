/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  classifyRefreshError,
  classifyTouchOutcome,
  exchangeCodeForUserToken,
  getUserAccessToken,
  toPublicSession,
} from "./userAuth";
import { getTenantAccessToken } from "./auth";
import { FEISHU_BASE, FeishuError, feishuFetch } from "./client";

vi.mock("./auth", () => ({ getTenantAccessToken: vi.fn() }));
vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockTenant = vi.mocked(getTenantAccessToken);
const mockFetch = vi.mocked(feishuFetch);

describe("toPublicSession", () => {
  it("maps a stored row to a public projection", () => {
    expect(
      toPublicSession(
        { openId: "ou_1", userName: "Jenny", avatarUrl: "http://a", expiresAt: 2000 },
        1000,
      ),
    ).toEqual({
      openId: "ou_1",
      userName: "Jenny",
      avatarUrl: "http://a",
      expiresAt: 2000,
      isExpired: false,
    });
  });

  it("marks equality with now as expired", () => {
    expect(toPublicSession({ openId: "ou_1", expiresAt: 1000 }, 1000).isExpired).toBe(true);
  });
});

function queueFetch(responses: unknown[]) {
  let i = 0;
  mockFetch.mockImplementation(async () => responses[i++] as never);
}

function firstMutationPayload(runMutation: { mock: { calls: unknown[][] } }): Record<string, unknown> {
  return (runMutation.mock.calls[0]?.[1] ?? {}) as Record<string, unknown>;
}

describe("exchangeCodeForUserToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenant.mockResolvedValue("tenant-tok");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeCtx() {
    const runMutation = vi.fn(async () => undefined);
    return {
      ctx: { runMutation } as unknown as Parameters<typeof exchangeCodeForUserToken>[0],
      runMutation,
    };
  }

  it("exchanges a code, fetches user_info, and stores the Feishu session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2_000_000));
    queueFetch([
      {
        data: {
          access_token: "user-at",
          refresh_token: "user-rt",
          token_type: "Bearer",
          expires_in: 7200,
        },
      },
      { data: { open_id: "ou_jenny", name: "Jenny", avatar_url: "http://a" } },
    ]);
    const { ctx, runMutation } = fakeCtx();

    await exchangeCodeForUserToken(ctx, "auth-code-xyz", "sess-1");

    expect(mockTenant).toHaveBeenCalledWith(ctx);
    expect(mockFetch.mock.calls[0][0]).toMatchObject({
      url: `${FEISHU_BASE}/authen/v1/oidc/access_token`,
      token: "tenant-tok",
      json: { grant_type: "authorization_code", code: "auth-code-xyz" },
    });
    expect(mockFetch.mock.calls[1][0]).toMatchObject({
      url: `${FEISHU_BASE}/authen/v1/user_info`,
      method: "GET",
      token: "user-at",
    });
    expect(firstMutationPayload(runMutation)).toEqual({
      sessionId: "sess-1",
      accessToken: "user-at",
      refreshToken: "user-rt",
      expiresAt: 2_000_000 + (7200 - 300) * 1000,
      tokenType: "Bearer",
      openId: "ou_jenny",
      userName: "Jenny",
      avatarUrl: "http://a",
    });
  });

  it("does not persist when the token exchange fails", async () => {
    mockFetch.mockRejectedValueOnce(new FeishuError(20037, "code expired", "Feishu user auth"));
    const { ctx, runMutation } = fakeCtx();
    await expect(exchangeCodeForUserToken(ctx, "stale-code", "sess-3")).rejects.toMatchObject({
      name: "FeishuError",
      code: 20037,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});

describe("getUserAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenant.mockResolvedValue("tenant-tok");
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function fakeCtx(session: unknown) {
    const runQuery = vi.fn(async () => session);
    const runMutation = vi.fn(async () => undefined);
    return {
      ctx: { runQuery, runMutation } as unknown as Parameters<typeof getUserAccessToken>[0],
      runQuery,
      runMutation,
    };
  }

  it("throws when no session exists", async () => {
    const { ctx } = fakeCtx(null);
    await expect(getUserAccessToken(ctx, "sess-x")).rejects.toThrow(
      "User not authenticated. Please login to Feishu first.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns a still-valid stored access token without refreshing", async () => {
    const { ctx, runMutation } = fakeCtx({
      accessToken: "still-valid",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
    });
    await expect(getUserAccessToken(ctx, "sess-y")).resolves.toBe("still-valid");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("refreshes an expired session and persists the rotated token", async () => {
    queueFetch([
      {
        data: {
          access_token: "rotated-at",
          refresh_token: "rotated-rt",
          token_type: "Bearer",
          expires_in: 7200,
        },
      },
      { data: { open_id: "ou_z", name: "Zed", avatar_url: "http://z" } },
    ]);
    const { ctx, runMutation } = fakeCtx({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: Date.now() - 1000,
    });

    await expect(getUserAccessToken(ctx, "sess-z")).resolves.toBe("rotated-at");
    expect(mockFetch.mock.calls[0][0]).toMatchObject({
      url: `${FEISHU_BASE}/authen/v1/oidc/refresh_access_token`,
      token: "tenant-tok",
      json: { grant_type: "refresh_token", refresh_token: "old-rt" },
    });
    expect(firstMutationPayload(runMutation)).toMatchObject({
      sessionId: "sess-z",
      accessToken: "rotated-at",
      refreshToken: "rotated-rt",
      openId: "ou_z",
    });
  });

  it("deletes the session and throws on a terminal refresh failure (dead refresh_token)", async () => {
    mockFetch.mockRejectedValue(new FeishuError(20037, "refresh token expired", "Feishu token refresh"));
    const { ctx, runMutation } = fakeCtx({
      accessToken: "old-at",
      refreshToken: "dead-rt",
      expiresAt: Date.now() - 1000,
    });
    await expect(getUserAccessToken(ctx, "sess-dead")).rejects.toThrow(/log in to Feishu again/i);
    // single attempt (terminal is never retried) and the dead session is deleted
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(runMutation).toHaveBeenCalledWith(expect.anything(), { sessionId: "sess-dead" });
  });

  it("retries once then throws transient without deleting the session", async () => {
    mockFetch.mockRejectedValue(new FeishuError(-1, "non-JSON response (status=502)", "Feishu token refresh"));
    const { ctx, runMutation } = fakeCtx({
      accessToken: "old-at",
      refreshToken: "rt",
      expiresAt: Date.now() - 1000,
    });
    await expect(getUserAccessToken(ctx, "sess-flaky")).rejects.toThrow(/Temporary Feishu authentication/i);
    expect(mockFetch).toHaveBeenCalledTimes(2); // initial + one retry
    expect(runMutation).not.toHaveBeenCalled(); // session preserved
  });
});

describe("classifyRefreshError", () => {
  it("treats a Feishu business-code rejection of the refresh_token as terminal", () => {
    expect(classifyRefreshError(new FeishuError(20037, "expired", "Feishu token refresh"))).toBe("terminal");
  });
  it("treats a non-JSON / gateway FeishuError (code -1) as transient", () => {
    expect(classifyRefreshError(new FeishuError(-1, "non-JSON", "Feishu token refresh"))).toBe("transient");
  });
  it("treats a thrown network error (no Feishu verdict) as transient", () => {
    expect(classifyRefreshError(new TypeError("fetch failed"))).toBe("transient");
    expect(classifyRefreshError(undefined)).toBe("transient");
  });
});

describe("classifyTouchOutcome", () => {
  // The terminal sentinel surfaced by the refresh path (refreshAccessTokenAttempt
  // throws `new Error(TERMINAL_MSG)` after deleting the row).
  const TERMINAL_MSG = "Feishu session expired. Please log in to Feishu again.";

  it("maps a missing session row to 'absent'", () => {
    expect(classifyTouchOutcome({ sessionExists: false })).toBe("absent");
  });

  it("maps a live / successfully refreshed token to 'ok'", () => {
    expect(classifyTouchOutcome({ sessionExists: true })).toBe("ok");
  });

  it("maps a terminal (dead refresh_token) failure to 'terminal'", () => {
    expect(
      classifyTouchOutcome({ sessionExists: true, error: new Error(TERMINAL_MSG) }),
    ).toBe("terminal");
  });

  it("maps a transient failure to 'ok' so a blip never clears the snapshot", () => {
    expect(
      classifyTouchOutcome({
        sessionExists: true,
        error: new Error("Temporary Feishu authentication failure. Please try again."),
      }),
    ).toBe("ok");
    expect(classifyTouchOutcome({ sessionExists: true, error: new TypeError("fetch failed") })).toBe("ok");
    expect(
      classifyTouchOutcome({
        sessionExists: true,
        error: new FeishuError(-1, "non-JSON", "Feishu token refresh"),
      }),
    ).toBe("ok");
  });
});
