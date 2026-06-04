import { useEffect, useRef, useState } from "react";
import type { FeishuUser } from "../components/taskpane/feishuUser";
import {
  clearAuthSnapshot,
  isSnapshotResumable,
  readAuthSnapshot,
  rememberAuthSnapshot,
  snapshotUser,
  type AuthSnapshot,
} from "./feishuAuthSnapshot";

export interface FallbackToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  openId: string;
  userName: string | null;
  avatarUrl: string | null;
}

export type UserSession = {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  expiresAt: number;
  isExpired: boolean;
} | null | undefined;

function sessionUser(session: Exclude<UserSession, null | undefined>): FeishuUser {
  return { openId: session.openId, userName: session.userName, avatarUrl: session.avatarUrl };
}

function fallbackUser(fallback: FallbackToken): FeishuUser {
  return {
    openId: fallback.openId,
    userName: fallback.userName ?? undefined,
    avatarUrl: fallback.avatarUrl ?? undefined,
  };
}

// Proactive boot-refresh verdict from touchSession (null = not yet resolved).
export type TouchResult = "absent" | "ok" | "terminal" | null;

// Fire the touchSession action ONCE on mount to proactively self-heal an
// expired-but-refreshable user token, so a returning user doesn't hit a possibly-
// terminal refresh mid-flow on the first coworker search. A genuine side effect
// (NOT render-phase). Guarded by a ref so a StrictMode double-invoke / fast
// remount doesn't double-refresh; failures are swallowed as a non-clearing 'ok'.
export function useProactiveTouch(
  touch: (args: { sessionId: string }) => Promise<TouchResult>,
  sessionId: string,
): TouchResult {
  const [touchResult, setTouchResult] = useState<TouchResult>(null);
  const didTouch = useRef(false);
  useEffect(() => {
    if (didTouch.current) return;
    didTouch.current = true;
    let cancelled = false;
    void touch({ sessionId })
      .then((status) => {
        if (!cancelled) setTouchResult(status);
      })
      .catch(() => {
        if (!cancelled) setTouchResult("ok");
      });
    return () => {
      cancelled = true;
    };
  }, [touch, sessionId]);
  return touchResult;
}

export function useAuthSnapshot({
  session,
  sessionId,
  convexLoggedIn,
  fallbackLoggedIn,
  touchResult = null,
}: {
  session: UserSession;
  sessionId: string;
  convexLoggedIn: boolean;
  fallbackLoggedIn: boolean;
  touchResult?: TouchResult;
}): AuthSnapshot | null {
  // Render-phase READ: synchronous so a returning user paints connected on frame 1.
  // Read ONCE at mount and never mirrored back via setState — the login-gate
  // booleans derive the "contradicted" state purely (deriveAuthFlags), so there is
  // no derived-value-copied-into-state. The effect below only touches localStorage.
  const [authSnapshot] = useState<AuthSnapshot | null>(() =>
    readAuthSnapshot(sessionId),
  );

  // Persist / clear the localStorage snapshot as the server session reconciles.
  // This is a genuine external-store synchronization side effect — it sets NO React
  // state, so first paint stays instant via the initializer read above. The trigger
  // is the REACTIVE getUserSession query (+ touchResult), not a user event, so there
  // is no event handler to move it to — react-doctor/no-event-handler is a false
  // positive for this "synchronize with an external system" case.
  /* eslint-disable react-doctor/no-event-handler -- reactive localStorage sync (driven by a query, not an event) */
  useEffect(() => {
    if (convexLoggedIn && session) {
      rememberAuthSnapshot(sessionId, sessionUser(session), session.expiresAt);
      return;
    }
    // Clear ONLY on an authoritative contradiction: getUserSession returned null
    // (row gone / rejected) or touchSession found the refresh token dead. NEVER on
    // `session === undefined` (in-flight) so a transient null mid-deploy can't wipe
    // the seam, and NEVER on a merely EXPIRED-but-present session — the presence
    // horizon deliberately outlives the access token (refresh renews it). The
    // fallback path (ADR-0008) keeps its own snapshot, so a primary-only touch
    // verdict must not clear it.
    const serverNull = session === null;
    const touchDead = touchResult === "terminal" || touchResult === "absent";
    if (!fallbackLoggedIn && (serverNull || touchDead)) {
      clearAuthSnapshot();
    }
  }, [convexLoggedIn, fallbackLoggedIn, session, sessionId, touchResult]);
  /* eslint-enable react-doctor/no-event-handler */

  return authSnapshot;
}

export interface AuthFlags {
  snapshotLoggedIn: boolean;
  isLoading: boolean;
  isLoggedIn: boolean;
}

// Pure derivation of the snapshot-dependent login-gate booleans, given the two
// snapshot-INDEPENDENT base flags (computed before useAuthSnapshot to avoid a
// cycle). Extracted so the precedence is unit-testable and the hook stays thin.
// snapshotLoggedIn trusts the snapshot within its presence horizon UNTIL
// getUserSession authoritatively returns null (session === null) — so it survives
// the access-token boundary and the query resolving non-null, and is forced false
// only on a real contradiction.
export function deriveAuthFlags({
  session,
  convexLoggedIn,
  fallbackLoggedIn,
  fallbackPresent,
  authSnapshot,
  isResumable,
  now,
  touchResult = null,
}: {
  session: UserSession;
  convexLoggedIn: boolean;
  fallbackLoggedIn: boolean;
  // Whether a raw fallback token exists at all (null === no token). isLoading keys
  // on this (not fallbackLoggedIn) so an expired-but-present token still suppresses
  // the in-flight checking shell, exactly as before.
  fallbackPresent: boolean;
  authSnapshot: AuthSnapshot | null;
  isResumable: (snapshot: AuthSnapshot | null, now?: number) => boolean;
  now: number;
  touchResult?: TouchResult;
}): AuthFlags {
  // The snapshot paints connected within its presence horizon UNTIL an authoritative
  // contradiction: getUserSession returned null, or touchSession found the refresh
  // token dead. An in-flight (undefined) or merely expired-but-present session does
  // NOT contradict — the horizon outlives the access token on purpose, so a returning
  // user whose token lapsed while the pane was closed stays connected while it
  // refreshes, instead of flashing the LoginScreen.
  const contradicted =
    session === null || touchResult === "terminal" || touchResult === "absent";
  const snapshotLoggedIn =
    authSnapshot !== null && isResumable(authSnapshot, now) && !contradicted;
  const isLoading = session === undefined && !fallbackPresent && !snapshotLoggedIn;
  const isLoggedIn = convexLoggedIn || fallbackLoggedIn || snapshotLoggedIn;
  return { snapshotLoggedIn, isLoading, isLoggedIn };
}

export function selectUser({
  authSnapshot,
  convexLoggedIn,
  fallback,
  fallbackLoggedIn,
  session,
  snapshotLoggedIn,
}: {
  authSnapshot: AuthSnapshot | null;
  convexLoggedIn: boolean;
  fallback: FallbackToken | null;
  fallbackLoggedIn: boolean;
  session: UserSession;
  snapshotLoggedIn: boolean;
}): FeishuUser | null {
  if (convexLoggedIn && session) return sessionUser(session);
  if (fallbackLoggedIn && fallback) return fallbackUser(fallback);
  if (snapshotLoggedIn && authSnapshot) return snapshotUser(authSnapshot);
  return null;
}

export interface DerivedAuthState {
  isLoading: boolean;
  isLoggedIn: boolean;
  user: FeishuUser | null;
  // Token to hand Coworker search: set ONLY on the box-fallback path (ADR-0008).
  // undefined → the Convex action reads the token from its DB (the primary path).
  userAccessToken?: string;
}

// Composes the snapshot reconciler (useAuthSnapshot) with the pure flag/user
// derivations so useFeishuAuth stays thin. The snapshot READ inside useAuthSnapshot
// is still a render-phase useState initializer (instant first paint); only the
// WRITE/CLEAR are effects.
export function useAuthState({
  session,
  sessionId,
  fallback,
  touchResult,
}: {
  session: UserSession;
  sessionId: string;
  fallback: FallbackToken | null;
  touchResult: TouchResult;
}): DerivedAuthState {
  const convexLoggedIn =
    session !== null && session !== undefined && !session.isExpired;
  const fallbackLoggedIn = fallback !== null && fallback.expiresAt > Date.now();
  const authSnapshot = useAuthSnapshot({
    session,
    sessionId,
    convexLoggedIn,
    fallbackLoggedIn,
    touchResult,
  });
  const { snapshotLoggedIn, isLoading, isLoggedIn } = deriveAuthFlags({
    session,
    convexLoggedIn,
    fallbackLoggedIn,
    fallbackPresent: fallback !== null,
    authSnapshot,
    isResumable: isSnapshotResumable,
    now: Date.now(),
    touchResult,
  });
  const user = selectUser({
    authSnapshot,
    convexLoggedIn,
    fallback,
    fallbackLoggedIn,
    session,
    snapshotLoggedIn,
  });
  const userAccessToken =
    !convexLoggedIn && fallbackLoggedIn && fallback ? fallback.accessToken : undefined;
  return { isLoading, isLoggedIn, user, userAccessToken };
}
