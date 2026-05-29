/* eslint-disable max-lines-per-function */
// Tests for the tenant-token layer (auth.ts).
//   - selectFreshToken / pruneTokenRows are pure (extracted from the two Convex
//     DB wrappers) and tested directly.
//   - getTenantAccessToken is a ctx-injectable helper: we pass a fake ActionCtx
//     ({ runQuery, runMutation }) and mock the transport (feishuFetch) so the
//     cache-hit, env-guard, request-shape, early-expiry, and propagation paths
//     are all exercised without a live Convex DB or network.
//
// Feishu tenant_access_token/internal request shape per official docs:
//   https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import {
  selectFreshToken,
  pruneTokenRows,
  getTenantAccessToken,
} from "./auth";
import { feishuFetch, FeishuError, FEISHU_BASE } from "./client";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockFetch = vi.mocked(feishuFetch);

describe("selectFreshToken (pure)", () => {
  it("returns the token when the row's expiresAt is strictly after now", () => {
    expect(selectFreshToken({ token: "t1", expiresAt: 2000 }, 1000)).toBe("t1");
  });

  it("returns null when the only row is expired (expiresAt <= now)", () => {
    expect(selectFreshToken({ token: "t1", expiresAt: 1000 }, 1000)).toBeNull();
    expect(selectFreshToken({ token: "t1", expiresAt: 500 }, 1000)).toBeNull();
  });

  it("returns null for a missing row (null / undefined)", () => {
    expect(selectFreshToken(null, 1000)).toBeNull();
    expect(selectFreshToken(undefined, 1000)).toBeNull();
  });
});

describe("pruneTokenRows (pure)", () => {
  it("returns delete ids for ALL existing rows, not just the first 10", () => {
    // Regression guard for the .take(10) cap: the pure selector must surface
    // every row id it is handed so no stale token rows survive.
    const rows = Array.from({ length: 13 }, (_, i) => ({ _id: `id${i}` }));
    expect(pruneTokenRows(rows)).toEqual(rows.map((r) => r._id));
    expect(pruneTokenRows(rows)).toHaveLength(13);
  });

  it("returns [] when there are no rows", () => {
    expect(pruneTokenRows([])).toEqual([]);
  });
});

describe("getTenantAccessToken", () => {
  const OLD_ENV = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FEISHU_APP_ID = "cli_app_id";
    process.env.FEISHU_APP_SECRET = "app_secret";
  });
  afterEach(() => {
    process.env = { ...OLD_ENV };
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeCtx(opts: {
    cached?: string | null;
    runMutation?: ReturnType<typeof vi.fn>;
  }) {
    const runQuery = vi.fn(async () => opts.cached ?? null);
    const runMutation = opts.runMutation ?? vi.fn(async () => undefined);
    return { runQuery, runMutation } as unknown as Parameters<
      typeof getTenantAccessToken
    >[0] & { runQuery: typeof runQuery; runMutation: typeof runMutation };
  }

  it("returns the cached token without calling fetch when runQuery resolves a non-null token", async () => {
    const ctx = fakeCtx({ cached: "cached-token" });
    const tok = await getTenantAccessToken(ctx);
    expect(tok).toBe("cached-token");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("throws when FEISHU_APP_ID is missing", async () => {
    delete process.env.FEISHU_APP_ID;
    const ctx = fakeCtx({ cached: null });
    await expect(getTenantAccessToken(ctx)).rejects.toThrow(
      "FEISHU_APP_ID and FEISHU_APP_SECRET must be set",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("throws when FEISHU_APP_SECRET is missing", async () => {
    delete process.env.FEISHU_APP_SECRET;
    const ctx = fakeCtx({ cached: null });
    await expect(getTenantAccessToken(ctx)).rejects.toThrow(
      "FEISHU_APP_ID and FEISHU_APP_SECRET must be set",
    );
  });

  it("POSTs to the tenant_access_token/internal endpoint with {app_id, app_secret} on a cache miss", async () => {
    mockFetch.mockResolvedValue({ tenant_access_token: "tok", expire: 7200 });
    const ctx = fakeCtx({ cached: null });
    await getTenantAccessToken(ctx);
    const sent = mockFetch.mock.calls[0][0];
    expect(sent.url).toBe(`${FEISHU_BASE}/auth/v3/tenant_access_token/internal`);
    expect(sent.json).toEqual({ app_id: "cli_app_id", app_secret: "app_secret" });
    expect(sent.label).toBe("Feishu auth");
  });

  it("computes expiresAt = now + (expire - 300)*1000 and stores it via runMutation exactly once", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    mockFetch.mockResolvedValue({ tenant_access_token: "tok", expire: 7200 });
    const runMutation = vi.fn(async () => undefined);
    const ctx = fakeCtx({ cached: null, runMutation });

    const tok = await getTenantAccessToken(ctx);

    expect(tok).toBe("tok");
    expect(runMutation).toHaveBeenCalledTimes(1);
    // expire 7200s, minus the 300s early-expiry margin = 6900s after `now`.
    const expectedExpiresAt = 1_000_000 + (7200 - 300) * 1000;
    expect(runMutation.mock.calls[0][1]).toEqual({
      token: "tok",
      expiresAt: expectedExpiresAt,
    });
  });

  it("propagates a FeishuError from the auth endpoint and does NOT call storeToken", async () => {
    mockFetch.mockRejectedValue(
      new FeishuError(99991663, "app secret invalid", "Feishu auth"),
    );
    const runMutation = vi.fn(async () => undefined);
    const ctx = fakeCtx({ cached: null, runMutation });

    await expect(getTenantAccessToken(ctx)).rejects.toMatchObject({
      name: "FeishuError",
      code: 99991663,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});
