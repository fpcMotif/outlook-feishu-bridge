import { action } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";

// Search Users response (open.feishu.cn GET /open-apis/search/v1/user): each
// user carries open_id, name, and usually an `avatar` object of sized URLs.
// Some tenants/API responses omit avatar_72 but include a larger avatar size,
// so the projection below falls back through the available Feishu avatar fields.
// `user_id` is only returned with contact:user.employee_id:readonly, which we
// don't request — Bitable Sync assigns Coworkers by open_id. See ADR-0003.
export interface FeishuUser {
  open_id: string;
  name: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  avatar_url?: string;
  department_ids?: string[];
}

export interface Coworker {
  openId: string;
  name: string;
  avatarUrl?: string;
}

export function coworkerAvatarUrl(u: FeishuUser): string | undefined {
  return (
    u.avatar?.avatar_72 ??
    u.avatar?.avatar_240 ??
    u.avatar?.avatar_640 ??
    u.avatar?.avatar_origin ??
    u.avatar_url
  );
}

export function mapFeishuUserToCoworker(u: FeishuUser): Coworker {
  return {
    openId: u.open_id,
    name: u.name,
    avatarUrl: coworkerAvatarUrl(u),
  };
}

export function mapCoworkers(data: { users?: FeishuUser[] }): Coworker[] {
  return (data.users ?? []).map((u) => mapFeishuUserToCoworker(u));
}

function logCoworkerAvatarDiagnostics(users: FeishuUser[], coworkers: Coworker[]) {
  const avatarKeys = new Set<string>();
  for (const user of users) {
    for (const key of Object.keys(user.avatar ?? {})) avatarKeys.add(key);
    if (user.avatar_url) avatarKeys.add("avatar_url");
  }
  const withAvatar = coworkers.filter((coworker) => Boolean(coworker.avatarUrl)).length;
  console.log(
    `[coworkers] Search Users returned users=${users.length} avatars=${withAvatar} avatarKeys=${[
      ...avatarKeys,
    ].join(",") || "none"}`,
  );
}

export const searchCoworkers = action({
  args: {
    sessionId: v.string(),
    query: v.string(),
    userAccessToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    // Search Users is a GET with the keyword in the `query` URL param (scope
    // contact:user:search) — NOT a POST with a JSON body. See ADR-0003.
    const data = await callFeishu<{ users?: FeishuUser[] }>(ctx, {
      path: "/search/v1/user",
      method: "GET",
      query: { query: args.query, page_size: "20" },
      auth: "user",
      sessionId: args.sessionId,
      token: args.userAccessToken,
      label: "Coworker search",
    });

    const users = data.users ?? [];
    const coworkers = mapCoworkers(data);
    logCoworkerAvatarDiagnostics(users, coworkers);
    return coworkers;
  },
});
