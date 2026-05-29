/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTenantAccessToken, pruneTokenRows, selectFreshToken } from "./auth";
import { FEISHU_BASE, FeishuError, feishuFetch } from "./client";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockFetch = vi.mocked(feishuFetch);

describe("selectFreshToken", () => {
  it("returns the token only when expiresAt is strictly after now", () => {
    expect(selectFreshToken({ token: "t1", expiresAt: 2000 }, 1000)).toBe("t1");
    expect(selectFreshToken({ token: "t1", expiresAt: 1000 }, 1000)).toBeNull();
    expect(selectFreshToken({ token: "t1", expiresAt: 500 }, 1000)).toBeNull();
  });

  it("returns null for missing rows", () => {
    expect(selectFreshToken(null, 1000)).toBeNull();
    expect(selectFreshToken(undefined, 1000)).toBeNull();
  });
});

describe("pruneTokenRows", () => {
  it("returns every row id it is handed", () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ _id: `id${i}` }));
    expect(pruneTokenRows(rows)).toEqual(rows.map((r) => r._id));
  });
});

describe("getTenantAccessToken", () => {
  const oldEnv = { ...process.env };

  beforeEach(() => {
    vi.clearAllMocks();
    process.env.FEISHU_APP_ID = "cli_app_id";
    process.env.FEISHU_APP_SECRET = "app_secret";
  });

  afterEach(() => {
    process.env = { ...oldEnv };
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

  it("returns the cached token without calling fetch", async () => {
    const ctx = fakeCtx({ cached: "cached-token" });
    await expect(getTenantAccessToken(ctx)).resolves.toBe("cached-token");
    expect(mockFetch).not.toHaveBeenCalled();
    expect(ctx.runMutation).not.toHaveBeenCalled();
  });

  it("throws when credentials are missing", async () => {
    delete process.env.FEISHU_APP_ID;
    await expect(getTenantAccessToken(fakeCtx({ cached: null }))).rejects.toThrow(
      "FEISHU_APP_ID and FEISHU_APP_SECRET must be set",
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("POSTs the tenant token endpoint and stores an early-expiring token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(1_000_000));
    mockFetch.mockResolvedValue({ tenant_access_token: "tok", expire: 7200 });
    const runMutation = vi.fn(async () => undefined);
    const ctx = fakeCtx({ cached: null, runMutation });

    await expect(getTenantAccessToken(ctx)).resolves.toBe("tok");

    expect(mockFetch).toHaveBeenCalledWith({
      url: `${FEISHU_BASE}/auth/v3/tenant_access_token/internal`,
      label: "Feishu auth",
      json: { app_id: "cli_app_id", app_secret: "app_secret" },
    });
    expect(runMutation.mock.calls[0]?.[1]).toEqual({
      token: "tok",
      expiresAt: 1_000_000 + (7200 - 300) * 1000,
    });
  });

  it("propagates Feishu errors and does not store a token", async () => {
    mockFetch.mockRejectedValue(new FeishuError(99991663, "app secret invalid", "Feishu auth"));
    const runMutation = vi.fn(async () => undefined);
    await expect(getTenantAccessToken(fakeCtx({ cached: null, runMutation }))).rejects.toMatchObject({
      name: "FeishuError",
      code: 99991663,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});
