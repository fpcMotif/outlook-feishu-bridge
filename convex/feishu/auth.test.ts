/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getTenantAccessToken, planTokenStore, selectFreshToken } from "./auth";
import { FEISHU_BASE, FeishuError, feishuFetch } from "./client";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockFetch = vi.mocked(feishuFetch);

const row = (id: string, expiresAt: number) => ({ _id: id, expiresAt });

function fakeCtx(opts: {
  cached?: string | null;
  runMutation?: ReturnType<typeof vi.fn>;
}) {
  const runQuery = vi.fn(async () => opts.cached ?? null);
  const runMutation = opts.runMutation ?? vi.fn(async () => {});
  return { runQuery, runMutation } as unknown as Parameters<
    typeof getTenantAccessToken
  >[0] & { runQuery: typeof runQuery; runMutation: typeof runMutation };
}

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

describe("planTokenStore", () => {
  const NOW = 1_000_000;

  it("inserts when the table is empty", () => {
    expect(planTokenStore([], NOW)).toEqual({ action: "insert", deleteIds: [] });
  });

  it("patches the single row in place when it is stale", () => {
    expect(planTokenStore([row("a", NOW - 1)], NOW)).toEqual({
      action: "patch",
      target: "a",
      deleteIds: [],
    });
  });

  it("treats expiresAt === now as stale (strict >, matching selectFreshToken)", () => {
    expect(planTokenStore([row("a", NOW)], NOW)).toEqual({
      action: "patch",
      target: "a",
      deleteIds: [],
    });
  });

  it("skips the write when a still-fresh row exists (first-committer-wins)", () => {
    expect(planTokenStore([row("a", NOW + 1)], NOW)).toEqual({
      action: "skip",
      deleteIds: [],
    });
  });

  it("keeps the fresh row and prunes stragglers when fresh is not first", () => {
    expect(
      planTokenStore(
        [row("stale1", NOW - 1), row("fresh", NOW + 5000), row("stale2", NOW - 2)],
        NOW,
      ),
    ).toEqual({ action: "skip", deleteIds: ["stale1", "stale2"] });
  });

  it("keeps the longest-lived fresh row when several are fresh", () => {
    expect(
      planTokenStore(
        [row("soon", NOW + 1000), row("late", NOW + 9000), row("mid", NOW + 5000)],
        NOW,
      ),
    ).toEqual({ action: "skip", deleteIds: ["soon", "mid"] });
  });

  it("patches one row and prunes the rest when every row is stale", () => {
    expect(planTokenStore([row("a", NOW - 1), row("b", NOW - 2)], NOW)).toEqual({
      action: "patch",
      target: "a",
      deleteIds: ["b"],
    });
  });

  it("always converges to a single canonical row (exactly one survivor)", () => {
    const inputs = [
      [],
      [row("a", NOW + 1)],
      [row("a", NOW - 1)],
      [row("a", NOW - 1), row("b", NOW + 1), row("c", NOW + 2)],
      [row("a", NOW - 1), row("b", NOW - 2), row("c", NOW - 3)],
    ];
    for (const rows of inputs) {
      const plan = planTokenStore(rows, NOW);
      const deleted = new Set(plan.deleteIds);
      const survivors = rows.filter((r) => !deleted.has(r._id));
      // Empty input -> the freshly inserted row is the only survivor (0 existing
      // rows kept). Non-empty -> exactly one existing row survives, rest deleted.
      expect(survivors.length).toBe(rows.length === 0 ? 0 : 1);
    }
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
    const runMutation = vi.fn(async (_ref: unknown, _args: unknown) => {});
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

  it("returns the freshly fetched token even when caching it fails (best-effort store)", async () => {
    mockFetch.mockResolvedValue({ tenant_access_token: "tok2", expire: 7200 });
    const runMutation = vi.fn(async () => {
      throw new Error(
        "Documents read from or written to the table feishuTokens changed",
      );
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      getTenantAccessToken(fakeCtx({ cached: null, runMutation })),
    ).resolves.toBe("tok2");
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("propagates Feishu errors and does not store a token", async () => {
    mockFetch.mockRejectedValue(new FeishuError(99991663, "app secret invalid", "Feishu auth"));
    const runMutation = vi.fn(async () => {});
    await expect(getTenantAccessToken(fakeCtx({ cached: null, runMutation }))).rejects.toMatchObject({
      name: "FeishuError",
      code: 99991663,
    });
    expect(runMutation).not.toHaveBeenCalled();
  });
});
