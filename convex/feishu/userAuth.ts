/* eslint-disable max-lines -- token-refresh taxonomy (ADR-0003 amendment) grew this module past 300 lines */
import {
  action,
  internalMutation,
  internalQuery,
  query,
  mutation,
  type ActionCtx,
  type QueryCtx,
  type MutationCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { getTenantAccessToken } from "./auth";
import { feishuFetch, FeishuError, FEISHU_BASE } from "./client";

// Single source of the feishuUserTokens by_sessionId lookup, shared by the
// query + mutation handlers below so the index read isn't duplicated four ways.
function getSession(ctx: QueryCtx | MutationCtx, sessionId: string) {
  return ctx.db
    .query("feishuUserTokens")
    .withIndex("by_sessionId", (q) => q.eq("sessionId", sessionId))
    .unique();
}

// ── Queries ──────────────────────────────────────────────────────────

export const getSessionBySessionId = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    return await getSession(ctx, args.sessionId);
  },
});

export interface PublicUserSession {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  expiresAt: number;
  isExpired: boolean;
}

export interface StoredUserSession {
  openId: string;
  userName?: string;
  avatarUrl?: string;
  expiresAt: number;
}

export function toPublicSession(
  session: StoredUserSession,
  now: number,
): PublicUserSession {
  return {
    openId: session.openId,
    userName: session.userName,
    avatarUrl: session.avatarUrl,
    expiresAt: session.expiresAt,
    isExpired: session.expiresAt <= now,
  };
}

export const getUserSession = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx, args.sessionId);
    if (!session) return null;
    return toPublicSession(session, Date.now());
  },
});

// ── Mutations ────────────────────────────────────────────────────────

export const storeUserToken = internalMutation({
  args: {
    sessionId: v.string(),
    accessToken: v.string(),
    refreshToken: v.string(),
    expiresAt: v.number(),
    tokenType: v.string(),
    openId: v.string(),
    userName: v.optional(v.string()),
    avatarUrl: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Remove any existing session for this sessionId
    const existing = await getSession(ctx, args.sessionId);
    if (existing) {
      await ctx.db.delete(existing._id);
    }
    await ctx.db.insert("feishuUserTokens", {
      sessionId: args.sessionId,
      accessToken: args.accessToken,
      refreshToken: args.refreshToken,
      expiresAt: args.expiresAt,
      tokenType: args.tokenType,
      openId: args.openId,
      userName: args.userName,
      avatarUrl: args.avatarUrl,
    });
  },
});

export const logoutUser = mutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx, args.sessionId);
    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

// Server-side session teardown for a terminally-dead refresh_token (ADR-0003
// amendment): delete the row so the next getUserSession returns null and the UI
// shows login instead of failing coworker search forever.
export const deleteSession = internalMutation({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await getSession(ctx, args.sessionId);
    if (session) {
      await ctx.db.delete(session._id);
    }
  },
});

// ── Helper: get a valid user access token ────────────────────────────

interface FeishuUserTokenResponse {
  code: number;
  msg: string;
  data: {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
  };
}

interface FeishuUserInfoResponse {
  code: number;
  msg: string;
  data: {
    open_id: string;
    union_id?: string;
    name?: string;
    avatar_url?: string;
  };
}

async function fetchUserInfo(
  userAccessToken: string,
): Promise<FeishuUserInfoResponse["data"]> {
  const parsed = await feishuFetch<FeishuUserInfoResponse>({
    url: `${FEISHU_BASE}/authen/v1/user_info`,
    method: "GET",
    token: userAccessToken,
    label: "Feishu user info",
  });
  return parsed.data;
}

/**
 * Exchange an authorization code for user tokens.
 * Called from the HTTP OAuth callback handler.
 */
export async function exchangeCodeForUserToken(
  ctx: ActionCtx,
  code: string,
  sessionId: string,
): Promise<void> {
  const tenantToken = await getTenantAccessToken(ctx);

  const parsed = await feishuFetch<FeishuUserTokenResponse>({
    url: `${FEISHU_BASE}/authen/v1/oidc/access_token`,
    token: tenantToken,
    label: "Feishu user auth",
    json: { grant_type: "authorization_code", code },
  });

  const { access_token, refresh_token, token_type, expires_in } = parsed.data;
  // Expire 5 minutes early to avoid using stale tokens
  const expiresAt = Date.now() + (expires_in - 300) * 1000;

  // OIDC token endpoint doesn't return user info — fetch it separately
  const userInfo = await fetchUserInfo(access_token);

  await ctx.runMutation(internal.feishu.userAuth.storeUserToken, {
    sessionId,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt,
    tokenType: token_type,
    openId: userInfo.open_id,
    userName: userInfo.name,
    avatarUrl: userInfo.avatar_url,
  });
}

// Token-refresh outcome taxonomy (ADR-0003 amendment). A FeishuError carrying a
// real Feishu business code means Feishu rejected the refresh_token itself →
// terminal (the session can never recover). code -1 (non-JSON/gateway body) or a
// thrown network error means we never got a clean Feishu verdict → transient
// (retryable). Pure + unit-tested per ADR-0019.
export type RefreshFailureKind = "terminal" | "transient";

export function classifyRefreshError(err: unknown): RefreshFailureKind {
  if (err instanceof FeishuError) return err.code === -1 ? "transient" : "terminal";
  return "transient";
}

// One transient retry, short backoff (ADR-0003 amendment); terminal failures are
// never retried. Logging is secret-safe: refresh_token presence only, never value.
const REFRESH_MAX_RETRIES = 1;
const TERMINAL_MSG = "Feishu session expired. Please log in to Feishu again.";
const TRANSIENT_MSG = "Temporary Feishu authentication failure. Please try again.";
const sleep = (ms: number) =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });

async function refreshAccessTokenAttempt(
  ctx: ActionCtx,
  sessionId: string,
  tenantToken: string,
  refreshToken: string,
  startedAt: number,
  attempt: number,
): Promise<FeishuUserTokenResponse> {
  const hasRefreshToken = Boolean(refreshToken);
  try {
    return await feishuFetch<FeishuUserTokenResponse>({
      url: `${FEISHU_BASE}/authen/v1/oidc/refresh_access_token`,
      token: tenantToken,
      label: "Feishu token refresh",
      json: { grant_type: "refresh_token", refresh_token: refreshToken },
    });
  } catch (err) {
    const code = err instanceof FeishuError ? err.code : 0;
    if (classifyRefreshError(err) === "terminal") {
      console.error(
        `[userAuth] token refresh TERMINAL code=${code} hasRefreshToken=${hasRefreshToken} elapsed=${Date.now() - startedAt}ms`,
      );
      await ctx.runMutation(internal.feishu.userAuth.deleteSession, { sessionId });
      throw new Error(TERMINAL_MSG, { cause: err });
    }
    console.warn(
      `[userAuth] token refresh transient attempt=${attempt} code=${code} hasRefreshToken=${hasRefreshToken} elapsed=${Date.now() - startedAt}ms`,
    );
    if (attempt >= REFRESH_MAX_RETRIES) throw new Error(TRANSIENT_MSG, { cause: err });
    await sleep(300 * (attempt + 1));
    return refreshAccessTokenAttempt(
      ctx,
      sessionId,
      tenantToken,
      refreshToken,
      startedAt,
      attempt + 1,
    );
  }
}

function refreshAccessToken(
  ctx: ActionCtx,
  sessionId: string,
  tenantToken: string,
  refreshToken: string,
  startedAt: number,
): Promise<FeishuUserTokenResponse> {
  return refreshAccessTokenAttempt(ctx, sessionId, tenantToken, refreshToken, startedAt, 0);
}

/**
 * Refresh an expired user access token (ADR-0003 amendment: terminal vs
 * transient, one retry, auto-logout on a dead refresh_token).
 */
async function refreshUserToken(
  ctx: ActionCtx,
  sessionId: string,
  refreshToken: string,
): Promise<string> {
  const startedAt = Date.now();
  const tenantToken = await getTenantAccessToken(ctx);

  const parsed = await refreshAccessToken(ctx, sessionId, tenantToken, refreshToken, startedAt);

  const { access_token, refresh_token, token_type, expires_in } = parsed.data;
  const expiresAt = Date.now() + (expires_in - 300) * 1000;

  const userInfo = await fetchUserInfo(access_token);

  await ctx.runMutation(internal.feishu.userAuth.storeUserToken, {
    sessionId,
    accessToken: access_token,
    refreshToken: refresh_token,
    expiresAt,
    tokenType: token_type,
    openId: userInfo.open_id,
    userName: userInfo.name,
    avatarUrl: userInfo.avatar_url,
  });

  console.log(
    `[userAuth] token refresh ok hasRefreshToken=${Boolean(refreshToken)} elapsed=${Date.now() - startedAt}ms`,
  );
  return access_token;
}

/**
 * Get a valid user access token for the given session.
 * Automatically refreshes if expired.
 */
export async function getUserAccessToken(
  ctx: ActionCtx,
  sessionId: string,
): Promise<string> {
  const session = await ctx.runQuery(
    internal.feishu.userAuth.getSessionBySessionId,
    { sessionId },
  );
  if (!session) {
    throw new Error("User not authenticated. Please login to Feishu first.");
  }

  if (session.expiresAt > Date.now()) {
    return session.accessToken;
  }

  // Token expired — refresh it
  return refreshUserToken(ctx, sessionId, session.refreshToken);
}

// ── Proactive boot refresh (touchSession) ────────────────────────────

// touchSession's status enum. It NEVER carries a token — only a verdict the SPA
// uses to keep the optimistic snapshot or tear it down (mirrors toPublicSession's
// token-omission discipline).
//   absent   → no session row (treat like getUserSession null → login)
//   ok       → token is live OR was successfully refreshed OR a TRANSIENT refresh
//              blip (keep the user optimistically connected; the next coworker
//              search retries via the existing one-retry backoff)
//   terminal → the refresh_token is dead and the row was already deleted by the
//              refresh path → force logged-out
export type TouchStatus = "absent" | "ok" | "terminal";

// A touch attempt's raw outcome: either there was no session row, or
// getUserAccessToken was attempted and either resolved (no error) or threw.
export type TouchOutcome =
  | { sessionExists: false }
  | { sessionExists: true; error?: unknown };

// Pure mapping from a touch attempt to a status (the unit-tested seam, ADR-0019).
// No session row → 'absent'. A resolved attempt (no error) → 'ok'. A thrown error
// is 'terminal' ONLY when it is the terminal sentinel surfaced by the refresh path
// (the row is already gone); every other throw (transient gateway/network) maps to
// 'ok' so a blip never logs the user out.
export function classifyTouchOutcome(outcome: TouchOutcome): TouchStatus {
  if (!outcome.sessionExists) return "absent";
  const { error } = outcome;
  if (error === undefined) return "ok";
  if (error instanceof Error && error.message === TERMINAL_MSG) return "terminal";
  return "ok";
}

// Public, state-changing: fired once on SPA mount to proactively self-heal an
// expired-but-refreshable user token so a returning user doesn't hit a possibly-
// terminal refresh mid-flow on the first coworker search. Returns ONLY a status
// (never the token). Validates only sessionId.
// H2 note: like getUserSession this trusts a client-supplied sessionId as a bare
// lookup key (no ownership check) and, because it mutates token state via the
// refresh path, it must ship WITH the pending H2 sessionId-existence gate.
export const touchSession = action({
  args: { sessionId: v.string() },
  handler: async (ctx, args): Promise<TouchStatus> => {
    const session = await ctx.runQuery(
      internal.feishu.userAuth.getSessionBySessionId,
      { sessionId: args.sessionId },
    );
    if (!session) return classifyTouchOutcome({ sessionExists: false });
    try {
      // Drives the lazy refresh path when expired; the terminal branch already
      // deletes the row, so touchSession needs no extra teardown — it only reports.
      await getUserAccessToken(ctx, args.sessionId);
      return classifyTouchOutcome({ sessionExists: true });
    } catch (err) {
      return classifyTouchOutcome({ sessionExists: true, error: err });
    }
  },
});
