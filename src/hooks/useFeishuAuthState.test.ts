import { describe, expect, it } from "vitest";

import { deriveAuthFlags } from "./useFeishuAuthState";
import {
  PRESENCE_TTL_MS,
  isSnapshotResumable,
  type AuthSnapshot,
} from "./feishuAuthSnapshot";
import type { UserSession } from "./useFeishuAuthState";

const NOW = new Date("2026-06-04T08:00:00.000Z").getTime();

function flags(
  overrides: Partial<Parameters<typeof deriveAuthFlags>[0]> = {},
) {
  return deriveAuthFlags({
    session: undefined,
    convexLoggedIn: false,
    fallbackLoggedIn: false,
    fallbackPresent: false,
    authSnapshot: null,
    isResumable: isSnapshotResumable,
    now: NOW,
    ...overrides,
  });
}

function validSession(): Exclude<UserSession, null | undefined> {
  return { openId: "ou_jenny", userName: "Jenny", expiresAt: NOW + 60_000, isExpired: false };
}

function snapshot(overrides: Partial<AuthSnapshot> = {}): AuthSnapshot {
  return {
    sessionId: "sess-1",
    openId: "ou_jenny",
    expiresAt: NOW + 60_000,
    resumeUntil: NOW + PRESENCE_TTL_MS,
    ...overrides,
  };
}

describe("deriveAuthFlags", () => {
  it("a valid non-expired server session is connected, not loading", () => {
    const f = flags({ session: validSession(), convexLoggedIn: true });
    expect(f.isLoggedIn).toBe(true);
    expect(f.isLoading).toBe(false);
  });

  it("an expired server session (convexLoggedIn false, session non-null) is logged out", () => {
    const expired: UserSession = { openId: "ou_jenny", expiresAt: NOW - 1, isExpired: true };
    const f = flags({ session: expired, convexLoggedIn: false });
    expect(f.isLoggedIn).toBe(false);
    // session resolved (not undefined) → not loading → falls through to LoginScreen.
    expect(f.isLoading).toBe(false);
  });

  it("a missing server session (null) with no snapshot/fallback is logged out, not loading", () => {
    const f = flags({ session: null });
    expect(f.isLoggedIn).toBe(false);
    expect(f.isLoading).toBe(false);
  });

  it("in-flight query (undefined) with NO snapshot is loading (checking shell)", () => {
    const f = flags({ session: undefined });
    expect(f.isLoading).toBe(true);
    expect(f.isLoggedIn).toBe(false);
  });

  it("in-flight query (undefined) WITH a resumable snapshot paints connected instantly", () => {
    const f = flags({ session: undefined, authSnapshot: snapshot() });
    expect(f.snapshotLoggedIn).toBe(true);
    expect(f.isLoggedIn).toBe(true);
    expect(f.isLoading).toBe(false);
  });

  it("the resumable snapshot keeps painting connected AFTER the query resolves non-null", () => {
    const f = flags({
      session: validSession(),
      convexLoggedIn: true,
      authSnapshot: snapshot(),
    });
    // snapshotLoggedIn no longer collapses on resolve (session !== null holds).
    expect(f.snapshotLoggedIn).toBe(true);
    expect(f.isLoggedIn).toBe(true);
    expect(f.isLoading).toBe(false);
  });

  it("snapshot is forced false when the query authoritatively returns null", () => {
    const f = flags({ session: null, authSnapshot: snapshot() });
    expect(f.snapshotLoggedIn).toBe(false);
    expect(f.isLoggedIn).toBe(false);
  });

  it("a snapshot past the presence horizon does not resume", () => {
    const stale = snapshot({ resumeUntil: NOW - 1 });
    const f = flags({ session: undefined, authSnapshot: stale });
    expect(f.snapshotLoggedIn).toBe(false);
    // No resumable snapshot + in-flight query → loading.
    expect(f.isLoading).toBe(true);
  });

  it("the snapshot survives the access-token expiry while within the horizon", () => {
    // Access token expired 1s ago, but the presence horizon is days out.
    const f = flags({
      session: undefined,
      authSnapshot: snapshot({ expiresAt: NOW - 1000 }),
    });
    expect(f.snapshotLoggedIn).toBe(true);
    expect(f.isLoggedIn).toBe(true);
  });

  it("an expired-but-present fallback token still suppresses the checking shell", () => {
    // fallbackLoggedIn false (expired) but fallbackPresent true → isLoading false.
    const f = flags({ session: undefined, fallbackPresent: true, fallbackLoggedIn: false });
    expect(f.isLoading).toBe(false);
    expect(f.isLoggedIn).toBe(false);
  });

  it("a valid fallback token is logged in regardless of server session", () => {
    const f = flags({ session: null, fallbackPresent: true, fallbackLoggedIn: true });
    expect(f.isLoggedIn).toBe(true);
  });

  it("touchSession 'terminal' forces the snapshot logged out even while the query is in-flight", () => {
    const f = flags({ session: undefined, authSnapshot: snapshot(), touchResult: "terminal" });
    expect(f.snapshotLoggedIn).toBe(false);
    expect(f.isLoggedIn).toBe(false);
  });

  it("touchSession 'absent' forces the snapshot logged out", () => {
    const f = flags({ session: undefined, authSnapshot: snapshot(), touchResult: "absent" });
    expect(f.snapshotLoggedIn).toBe(false);
    expect(f.isLoggedIn).toBe(false);
  });

  it("touchSession 'ok' does not contradict the resumable snapshot", () => {
    const f = flags({ session: undefined, authSnapshot: snapshot(), touchResult: "ok" });
    expect(f.snapshotLoggedIn).toBe(true);
    expect(f.isLoggedIn).toBe(true);
  });

  it("an expired-but-present session keeps a resumable snapshot connected (horizon outlives the token)", () => {
    const expired: UserSession = { openId: "ou_jenny", expiresAt: NOW - 1, isExpired: true };
    const f = flags({ session: expired, convexLoggedIn: false, authSnapshot: snapshot() });
    // The whole point of the presence horizon: a lapsed access token does NOT drop
    // the user to LoginScreen — the snapshot carries them while refresh renews it.
    expect(f.snapshotLoggedIn).toBe(true);
    expect(f.isLoggedIn).toBe(true);
  });
});
