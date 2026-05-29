/* eslint-disable max-lines-per-function */
// Tests for the Feishu token-policy + call layer (call.ts). Both exports are
// pure ctx-injectable functions, so we mock the three collaborators it imports
// (./auth getTenantAccessToken, ./userAuth getUserAccessToken, ./client
// feishuFetch) and assert token selection, URL/querystring building, token
// passthrough, and the "succeeded but no data" throw.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { resolveFeishuToken, callFeishu } from "./call";
import { getTenantAccessToken } from "./auth";
import { getUserAccessToken } from "./userAuth";
import { feishuFetch, FEISHU_BASE, FeishuError } from "./client";

vi.mock("./auth", () => ({
  getTenantAccessToken: vi.fn(),
}));
vi.mock("./userAuth", () => ({
  getUserAccessToken: vi.fn(),
}));
vi.mock("./client", async () => {
  // Keep the real FEISHU_BASE/FeishuError so URL assertions and error-type
  // checks remain anchored to the actual module; only feishuFetch is faked.
  const actual = await vi.importActual<typeof import("./client")>("./client");
  return { ...actual, feishuFetch: vi.fn() };
});

const mockTenant = vi.mocked(getTenantAccessToken);
const mockUser = vi.mocked(getUserAccessToken);
const mockFetch = vi.mocked(feishuFetch);

// The ctx is opaque to call.ts (it only forwards it to the token getters), so a
// bare object suffices.
const ctx = {} as Parameters<typeof callFeishu>[0];

beforeEach(() => {
  vi.clearAllMocks();
});

describe("resolveFeishuToken", () => {
  it("throws when auth='user' and sessionId is undefined", () => {
    expect(() => resolveFeishuToken(ctx, "user")).toThrow(
      "sessionId is required for user-authenticated Feishu calls",
    );
    expect(mockUser).not.toHaveBeenCalled();
    expect(mockTenant).not.toHaveBeenCalled();
  });

  it("delegates to getUserAccessToken with the sessionId when auth='user'", async () => {
    mockUser.mockResolvedValue("user-tok");
    const tok = await resolveFeishuToken(ctx, "user", "sess-1");
    expect(tok).toBe("user-tok");
    expect(mockUser).toHaveBeenCalledWith(ctx, "sess-1");
    expect(mockTenant).not.toHaveBeenCalled();
  });

  it("delegates to getTenantAccessToken when auth='tenant' (sessionId ignored)", async () => {
    mockTenant.mockResolvedValue("tenant-tok");
    const tok = await resolveFeishuToken(ctx, "tenant", "ignored");
    expect(tok).toBe("tenant-tok");
    expect(mockTenant).toHaveBeenCalledWith(ctx);
    expect(mockUser).not.toHaveBeenCalled();
  });
});

describe("callFeishu — token resolution", () => {
  it("uses opts.token verbatim and skips token resolution when one is pre-resolved", async () => {
    mockFetch.mockResolvedValue({ data: { ok: 1 } });
    const data = await callFeishu(ctx, {
      path: "/im/v1/messages",
      auth: "tenant",
      token: "pre-resolved",
    });
    expect(data).toEqual({ ok: 1 });
    expect(mockTenant).not.toHaveBeenCalled();
    expect(mockUser).not.toHaveBeenCalled();
    const sent = mockFetch.mock.calls[0][0];
    expect(sent.token).toBe("pre-resolved");
  });

  it("resolves a tenant token via resolveFeishuToken when no opts.token is given", async () => {
    mockTenant.mockResolvedValue("fresh-tenant");
    mockFetch.mockResolvedValue({ data: {} });
    await callFeishu(ctx, { path: "/bitable/v1/x", auth: "tenant" });
    expect(mockTenant).toHaveBeenCalledWith(ctx);
    expect(mockFetch.mock.calls[0][0].token).toBe("fresh-tenant");
  });

  it("resolves a user token (with sessionId) when auth='user' and no opts.token", async () => {
    mockUser.mockResolvedValue("fresh-user");
    mockFetch.mockResolvedValue({ data: {} });
    await callFeishu(ctx, { path: "/search/v1/user", auth: "user", sessionId: "s9" });
    expect(mockUser).toHaveBeenCalledWith(ctx, "s9");
    expect(mockFetch.mock.calls[0][0].token).toBe("fresh-user");
  });
});

describe("callFeishu — URL / querystring building", () => {
  it("builds the URL as FEISHU_BASE + path with no query string when opts.query is absent", async () => {
    mockFetch.mockResolvedValue({ data: {} });
    await callFeishu(ctx, { path: "/im/v1/messages", auth: "tenant", token: "t" });
    expect(mockFetch.mock.calls[0][0].url).toBe(`${FEISHU_BASE}/im/v1/messages`);
  });

  it("appends a URLSearchParams-encoded query string when opts.query is present", async () => {
    mockFetch.mockResolvedValue({ data: {} });
    await callFeishu(ctx, {
      path: "/search/v1/user",
      auth: "tenant",
      token: "t",
      query: { keyword: "jenny doe", page_size: "20" },
    });
    expect(mockFetch.mock.calls[0][0].url).toBe(
      `${FEISHU_BASE}/search/v1/user?keyword=jenny+doe&page_size=20`,
    );
  });
});

describe("callFeishu — option passthrough and data unwrapping", () => {
  it("forwards method/json/form/label through to feishuFetch and returns the inner data payload", async () => {
    mockFetch.mockResolvedValue({ data: { record_id: "rec1" } });
    const form = new FormData();
    const data = await callFeishu(ctx, {
      path: "/p",
      auth: "tenant",
      token: "t",
      method: "PUT",
      json: { a: 1 },
      form,
      label: "Bitable create",
    });
    expect(data).toEqual({ record_id: "rec1" });
    const sent = mockFetch.mock.calls[0][0];
    expect(sent.method).toBe("PUT");
    expect(sent.json).toEqual({ a: 1 });
    expect(sent.form).toBe(form);
    expect(sent.label).toBe("Bitable create");
  });
});

describe("callFeishu — succeeded-but-no-data throw", () => {
  it("throws '<label> succeeded but returned no data' when data is undefined", async () => {
    mockFetch.mockResolvedValue({});
    await expect(
      callFeishu(ctx, { path: "/p", auth: "tenant", token: "t", label: "Bitable create" }),
    ).rejects.toThrow("Bitable create succeeded but returned no data");
  });

  it("falls back to 'Feishu API succeeded but returned no data' when no label is supplied", async () => {
    mockFetch.mockResolvedValue({});
    await expect(
      callFeishu(ctx, { path: "/p", auth: "tenant", token: "t" }),
    ).rejects.toThrow("Feishu API succeeded but returned no data");
  });
});

describe("callFeishu — error propagation", () => {
  it("propagates a FeishuError when feishuFetch throws on a non-zero envelope code", async () => {
    mockFetch.mockRejectedValue(new FeishuError(99991663, "token invalid", "Auth"));
    await expect(
      callFeishu(ctx, { path: "/p", auth: "tenant", token: "t" }),
    ).rejects.toMatchObject({ name: "FeishuError", code: 99991663 });
  });
});
