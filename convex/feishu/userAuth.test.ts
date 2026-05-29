/* eslint-disable max-lines-per-function */
// Tests for the user-token layer (userAuth.ts).
//   - toPublicSession is pure (extracted from the getUserSession query wrapper)
//     and tested directly.
//   - exchangeCodeForUserToken and getUserAccessToken are ctx-injectable helpers;
//     a fake ActionCtx ({ runQuery, runMutation }) plus a mocked transport
//     (feishuFetch) and a mocked getTenantAccessToken drive every branch,
//     including the file-private fetchUserInfo and refreshUserToken paths.
//
// Feishu OIDC endpoints per official docs:
//   access_token:  https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/get-user-access-token
//   refresh:       https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/refresh-user-access-token
//   user_info:     https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/login-state-management/get

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  toPublicSession,
  exchangeCodeForUserToken,
  getUserAccessToken,
} from "./userAuth";
import { getTenantAccessToken } from "./auth";
import { feishuFetch, FeishuError, FEISHU_BASE } from "./client";

vi.mock("./auth", () => ({ getTenantAccessToken: vi.fn() }));
vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockTenant = vi.mocked(getTenantAccessToken);
const mockFetch = vi.mocked(feishuFetch);

describe("toPublicSession (pure)", () => {
  it("maps a row to a public projection with isExpired:false when expiresAt > now", () => {
    const pub = toPublicSession(
      { openId: "ou_1", userName: "Jenny", avatarUrl: "http://a", expiresAt: 2000 },
      1000,
    );
    expect(pub).toEqual({
      openId: "ou_1",
      userName: "Jenny",
      avatarUrl: "http://a",
      isExpired: false,
    });
  });

  it("marks isExpired:true when expiresAt <= now (boundary equality is expired)", () => {
    expect(
      toPublicSession({ openId: "ou_1", expiresAt: 1000 }, 1000).isExpired,
    ).toBe(true);
    expect(
      toPublicSession({ openId: "ou_1", expiresAt: 999 }, 1000).isExpired,
    ).toBe(true);
  });

  it("passes undefined userName/avatarUrl through unchanged", () => {
    const pub = toPublicSession({ openId: "ou_1", expiresAt: 5000 }, 1000);
    expect(pub.userName).toBeUndefined();
    expect(pub.avatarUrl).toBeUndefined();
  });
});

// A queued fake transport: each feishuFetch call returns the next queued value,
// so we can script the (oidc access_token | refresh) -> user_info sequence.
function queueFetch(responses: unknown[]) {
  let i = 0;
  mockFetch.mockImplementation(async () => responses[i++] as never);
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

  it("acquires a tenant token, POSTs grant_type=authorization_code, then GETs user_info with the new access_token as bearer", async () => {
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
    const { ctx } = fakeCtx();

    await exchangeCodeForUserToken(ctx, "auth-code-xyz", "sess-1");

    expect(mockTenant).toHaveBeenCalledWith(ctx);

    const tokenReq = mockFetch.mock.calls[0][0];
    expect(tokenReq.url).toBe(`${FEISHU_BASE}/authen/v1/oidc/access_token`);
    expect(tokenReq.token).toBe("tenant-tok");
    expect(tokenReq.json).toEqual({
      grant_type: "authorization_code",
      code: "auth-code-xyz",
    });

    const infoReq = mockFetch.mock.calls[1][0];
    expect(infoReq.url).toBe(`${FEISHU_BASE}/authen/v1/user_info`);
    expect(infoReq.method).toBe("GET");
    expect(infoReq.token).toBe("user-at");
  });

  it("computes expiresAt with the 300s early-expiry margin and persists profile via storeUserToken", async () => {
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

    await exchangeCodeForUserToken(ctx, "code", "sess-1");

    expect(runMutation).toHaveBeenCalledTimes(1);
    expect(runMutation.mock.calls[0][1]).toEqual({
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

  it("persists undefined userName/avatarUrl when user_info omits name/avatar_url", async () => {
    queueFetch([
      {
        data: {
          access_token: "user-at",
          refresh_token: "user-rt",
          token_type: "Bearer",
          expires_in: 7200,
        },
      },
      { data: { open_id: "ou_min" } },
    ]);
    const { ctx, runMutation } = fakeCtx();

    await exchangeCodeForUserToken(ctx, "code", "sess-2");

    const payload = runMutation.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.openId).toBe("ou_min");
    expect(payload.userName).toBeUndefined();
    expect(payload.avatarUrl).toBeUndefined();
  });

  it("propagates a FeishuError from the oidc/access_token endpoint and never calls storeUserToken", async () => {
    mockFetch.mockRejectedValueOnce(
      new FeishuError(20037, "code expired", "Feishu user auth"),
    );
    const { ctx, runMutation } = fakeCtx();

    await expect(
      exchangeCodeForUserToken(ctx, "stale-code", "sess-3"),
    ).rejects.toMatchObject({ name: "FeishuError", code: 20037 });
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("propagates when the follow-up user_info call fails (nothing persisted)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        data: {
          access_token: "user-at",
          refresh_token: "user-rt",
          token_type: "Bearer",
          expires_in: 7200,
        },
      } as never)
      .mockRejectedValueOnce(new FeishuError(99991663, "token invalid", "Feishu user info"));
    const { ctx, runMutation } = fakeCtx();

    await expect(
      exchangeCodeForUserToken(ctx, "code", "sess-4"),
    ).rejects.toMatchObject({ name: "FeishuError", code: 99991663 });
    expect(runMutation).not.toHaveBeenCalled();
  });
});

describe("getUserAccessToken", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTenant.mockResolvedValue("tenant-tok");
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeCtx(session: unknown) {
    const runQuery = vi.fn(async () => session);
    const runMutation = vi.fn(async () => undefined);
    return {
      ctx: { runQuery, runMutation } as unknown as Parameters<
        typeof getUserAccessToken
      >[0],
      runQuery,
      runMutation,
    };
  }

  it("throws 'User not authenticated...' when runQuery returns null", async () => {
    const { ctx } = fakeCtx(null);
    await expect(getUserAccessToken(ctx, "sess-x")).rejects.toThrow(
      "User not authenticated. Please login to Feishu first.",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("returns the stored accessToken without fetching when session.expiresAt > now", async () => {
    const { ctx, runMutation } = fakeCtx({
      accessToken: "still-valid",
      refreshToken: "rt",
      expiresAt: Date.now() + 60_000,
    });
    const tok = await getUserAccessToken(ctx, "sess-y");
    expect(tok).toBe("still-valid");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(runMutation).not.toHaveBeenCalled();
  });

  it("refreshes via oidc/refresh_access_token (grant_type=refresh_token) when expired and returns the new access_token", async () => {
    queueFetch([
      {
        data: {
          access_token: "rotated-at",
          refresh_token: "rotated-rt",
          token_type: "Bearer",
          expires_in: 7200,
        },
      },
      { data: { open_id: "ou_z", name: "Zed" } },
    ]);
    const { ctx } = fakeCtx({
      accessToken: "old-at",
      refreshToken: "old-rt",
      expiresAt: Date.now() - 1000, // expired
    });

    const tok = await getUserAccessToken(ctx, "sess-z");

    expect(tok).toBe("rotated-at");
    const refreshReq = mockFetch.mock.calls[0][0];
    expect(refreshReq.url).toBe(`${FEISHU_BASE}/authen/v1/oidc/refresh_access_token`);
    expect(refreshReq.token).toBe("tenant-tok");
    expect(refreshReq.json).toEqual({
      grant_type: "refresh_token",
      refresh_token: "old-rt",
    });
  });

  it("re-fetches user_info and re-persists the rotated refresh_token via storeUserToken on the refresh path", async () => {
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

    await getUserAccessToken(ctx, "sess-z");

    // user_info is the second transport call, using the rotated access token.
    expect(mockFetch.mock.calls[1][0].url).toBe(`${FEISHU_BASE}/authen/v1/user_info`);
    expect(mockFetch.mock.calls[1][0].token).toBe("rotated-at");

    expect(runMutation).toHaveBeenCalledTimes(1);
    const payload = runMutation.mock.calls[0][1] as Record<string, unknown>;
    expect(payload.sessionId).toBe("sess-z");
    expect(payload.accessToken).toBe("rotated-at");
    expect(payload.refreshToken).toBe("rotated-rt");
    expect(payload.openId).toBe("ou_z");
  });

  it("propagates a FeishuError when the refresh endpoint rejects the refresh_token", async () => {
    mockFetch.mockRejectedValueOnce(
      new FeishuError(20037, "refresh token expired", "Feishu token refresh"),
    );
    const { ctx, runMutation } = fakeCtx({
      accessToken: "old-at",
      refreshToken: "dead-rt",
      expiresAt: Date.now() - 1000,
    });

    await expect(getUserAccessToken(ctx, "sess-z")).rejects.toMatchObject({
      name: "FeishuError",
      code: 20037,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});
