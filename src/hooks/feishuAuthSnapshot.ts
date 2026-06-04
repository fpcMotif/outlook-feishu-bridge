import type { FeishuUser } from "../components/taskpane/feishuUser";

const AUTH_SNAPSHOT_KEY = "feishu_auth_snapshot";

// Instant-render horizon, decoupled from the ~2h user_access_token expiry. It is
// tied to the Feishu refresh_token life so a returning user keeps painting the
// connected shell long after the access token lapses (the server still refreshes
// the token lazily, and touchSession refreshes it proactively on mount). This is
// NOT a trust grant — every privileged action is still server-authorized against
// the sessionId; it only governs how long the optimistic connected paint lasts
// before the authoritative getUserSession query confirms or contradicts it.
// Feishu user refresh_token TTL is ~30 days (see openQuestions in the plan —
// confirm against open.feishu.cn before widening further).
export const PRESENCE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export interface AuthSnapshot {
  sessionId: string;
  // The user_access_token expiry (5-min-skewed), kept for reference only. It is
  // NO LONGER the instant-render gate — resumeUntil is.
  expiresAt: number;
  // The instant-render horizon: now + PRESENCE_TTL_MS at write time.
  resumeUntil: number;
  openId: string;
  userName?: string;
  avatarUrl?: string;
}

// Pure decision shared by the hook and tests: is this snapshot still within its
// presence horizon? Fail-closed — a missing/NaN resumeUntil or a lapsed horizon
// is not resumable.
export function isSnapshotResumable(
  snapshot: AuthSnapshot | null,
  now = Date.now(),
): boolean {
  return (
    snapshot !== null &&
    typeof snapshot.resumeUntil === "number" &&
    snapshot.resumeUntil > now
  );
}

export function snapshotUser(snapshot: AuthSnapshot): FeishuUser {
  return {
    openId: snapshot.openId,
    userName: snapshot.userName,
    avatarUrl: snapshot.avatarUrl,
  };
}

export function readAuthSnapshot(sessionId: string, now = Date.now()): AuthSnapshot | null {
  try {
    const raw = localStorage.getItem(AUTH_SNAPSHOT_KEY);
    if (!raw) return null;
    const snapshot = JSON.parse(raw) as Partial<AuthSnapshot>;
    if (
      snapshot.sessionId !== sessionId ||
      typeof snapshot.openId !== "string" ||
      snapshot.openId === "" ||
      typeof snapshot.expiresAt !== "number"
    ) {
      return null;
    }
    const restored: AuthSnapshot = {
      sessionId,
      openId: snapshot.openId,
      userName: typeof snapshot.userName === "string" ? snapshot.userName : undefined,
      avatarUrl: typeof snapshot.avatarUrl === "string" ? snapshot.avatarUrl : undefined,
      expiresAt: snapshot.expiresAt,
      resumeUntil: typeof snapshot.resumeUntil === "number" ? snapshot.resumeUntil : 0,
    };
    // Instant-render eligibility is gated on the presence horizon, NOT the
    // access-token expiry. A legacy record written before resumeUntil existed
    // has resumeUntil=0 → not resumable → null (one-time AuthResolvingScreen on
    // first reopen after deploy, then re-stamped on the getUserSession resolve).
    if (!isSnapshotResumable(restored, now)) return null;
    return restored;
  } catch {
    return null;
  }
}

export function rememberAuthSnapshot(
  sessionId: string,
  user: FeishuUser,
  expiresAt: number,
  now = Date.now(),
): void {
  const snapshot: AuthSnapshot = {
    sessionId,
    openId: user.openId,
    expiresAt,
    resumeUntil: now + PRESENCE_TTL_MS,
  };
  if (user.userName) snapshot.userName = user.userName;
  if (user.avatarUrl) snapshot.avatarUrl = user.avatarUrl;
  localStorage.setItem(AUTH_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

export function clearAuthSnapshot(): void {
  localStorage.removeItem(AUTH_SNAPSHOT_KEY);
}
