import {
  internalMutation,
  internalQuery,
  query,
  mutation,
  type ActionCtx,
} from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { getTenantAccessToken } from "./auth";
import { feishuFetch, FEISHU_BASE } from "./client";

// ── Queries ──────────────────────────────────────────────────────────

export const getSessionBySessionId = internalQuery({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
  },
});

export interface PublicUserSession {
  openId: string;
  userName?: string;
  avatarUrl?: string;
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
    isExpired: session.expiresAt <= now,
  };
}

export const getUserSession = query({
  args: { sessionId: v.string() },
  handler: async (ctx, args) => {
    const session = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
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
    const existing = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
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
    const session = await ctx.db
      .query("feishuUserTokens")
      .withIndex("by_sessionId", (q) => q.eq("sessionId", args.sessionId))
      .unique();
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

/**
 * Refresh an expired user access token.
 */
async function refreshUserToken(
  ctx: ActionCtx,
  sessionId: string,
  refreshToken: string,
): Promise<string> {
  const tenantToken = await getTenantAccessToken(ctx);

  const parsed = await feishuFetch<FeishuUserTokenResponse>({
    url: `${FEISHU_BASE}/authen/v1/oidc/refresh_access_token`,
    token: tenantToken,
    label: "Feishu token refresh",
    json: { grant_type: "refresh_token", refresh_token: refreshToken },
  });

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
