import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PRESENCE_TTL_MS,
  clearAuthSnapshot,
  isSnapshotResumable,
  readAuthSnapshot,
  rememberAuthSnapshot,
  type AuthSnapshot,
} from "./feishuAuthSnapshot";

const AUTH_SNAPSHOT_KEY = "feishu_auth_snapshot";
const NOW = new Date("2026-06-04T08:00:00.000Z").getTime();

function makeSnapshot(overrides: Partial<AuthSnapshot> = {}): AuthSnapshot {
  return {
    sessionId: "sess-1",
    openId: "ou_jenny",
    userName: "Jenny Xu",
    expiresAt: NOW + 60_000,
    resumeUntil: NOW + PRESENCE_TTL_MS,
    ...overrides,
  };
}

describe("isSnapshotResumable", () => {
  it("is true while inside the presence horizon", () => {
    expect(isSnapshotResumable(makeSnapshot(), NOW)).toBe(true);
    // Still resumable well past the ~2h access-token expiry (decoupled horizon).
    expect(isSnapshotResumable(makeSnapshot(), NOW + 3 * 60 * 60 * 1000)).toBe(true);
  });

  it("is false once the presence horizon has lapsed", () => {
    expect(isSnapshotResumable(makeSnapshot(), NOW + PRESENCE_TTL_MS)).toBe(false);
    expect(isSnapshotResumable(makeSnapshot(), NOW + PRESENCE_TTL_MS + 1)).toBe(false);
  });

  it("is false for a null snapshot or a non-number/missing resumeUntil (fail-closed)", () => {
    expect(isSnapshotResumable(null, NOW)).toBe(false);
    expect(isSnapshotResumable(makeSnapshot({ resumeUntil: 0 }), NOW)).toBe(false);
    expect(
      isSnapshotResumable(
        makeSnapshot({ resumeUntil: undefined as unknown as number }),
        NOW,
      ),
    ).toBe(false);
  });
});

describe("feishuAuthSnapshot read/write", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("writes a resumeUntil horizon and NO token field", () => {
    rememberAuthSnapshot(
      "sess-1",
      { openId: "ou_jenny", userName: "Jenny Xu", avatarUrl: "https://example.test/j.png" },
      NOW + 60_000,
      NOW,
    );

    expect(readAuthSnapshot("sess-1", NOW)).toEqual({
      sessionId: "sess-1",
      openId: "ou_jenny",
      userName: "Jenny Xu",
      avatarUrl: "https://example.test/j.png",
      expiresAt: NOW + 60_000,
      resumeUntil: NOW + PRESENCE_TTL_MS,
    });

    const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY) ?? "";
    expect(raw).not.toContain("accessToken");
    expect(raw).not.toContain("refreshToken");
  });

  it("resumes within the horizon even after the access-token expiresAt has passed", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, NOW + 60_000, NOW);

    // 3h later: access token is long expired but the presence horizon holds.
    const later = NOW + 3 * 60 * 60 * 1000;
    const restored = readAuthSnapshot("sess-1", later);
    expect(restored).not.toBeNull();
    expect(restored?.openId).toBe("ou_jenny");
  });

  it("returns null past the presence horizon", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, NOW + 60_000, NOW);
    expect(readAuthSnapshot("sess-1", NOW + PRESENCE_TTL_MS + 1)).toBeNull();
  });

  it("returns null for a legacy record lacking resumeUntil (one-time degradation)", () => {
    // Simulate a snapshot written before resumeUntil existed.
    localStorage.setItem(
      AUTH_SNAPSHOT_KEY,
      JSON.stringify({ sessionId: "sess-1", openId: "ou_jenny", expiresAt: NOW + 60_000 }),
    );
    expect(readAuthSnapshot("sess-1", NOW)).toBeNull();
  });

  it("still rejects a sessionId mismatch and an empty openId", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, NOW + 60_000, NOW);
    expect(readAuthSnapshot("sess-2", NOW)).toBeNull();

    localStorage.setItem(
      AUTH_SNAPSHOT_KEY,
      JSON.stringify({
        sessionId: "sess-1",
        openId: "",
        expiresAt: NOW + 60_000,
        resumeUntil: NOW + PRESENCE_TTL_MS,
      }),
    );
    expect(readAuthSnapshot("sess-1", NOW)).toBeNull();
  });

  it("clears the stored snapshot", () => {
    rememberAuthSnapshot("sess-1", { openId: "ou_jenny" }, NOW + 60_000, NOW);
    clearAuthSnapshot();
    expect(readAuthSnapshot("sess-1", NOW)).toBeNull();
  });
});
