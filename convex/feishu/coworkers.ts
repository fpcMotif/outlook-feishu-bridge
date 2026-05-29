import { action } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";

// Search Users response (open.feishu.cn GET /open-apis/search/v1/user): each
// user carries open_id, name, an `avatar` object of sized URLs, and
// department_ids. `user_id` is only returned with contact:user.employee_id:readonly,
// which we don't request — Bitable Sync assigns Coworkers by open_id. See ADR-0003.
export interface FeishuUser {
  open_id: string;
  name: string;
  avatar?: {
    avatar_72?: string;
    avatar_240?: string;
    avatar_640?: string;
    avatar_origin?: string;
  };
  department_ids?: string[];
}

// The slim Coworker projection the SPA renders in the Bitable-Sync coworker
// picker. Pure — no I/O — so the open_id/name/avatar mapping is unit-tested in
// isolation (mirrors customers.ts's exported `mapFeishuItemToCustomer`).
export interface Coworker {
  openId: string;
  name: string;
  avatarUrl?: string;
}

// Project one Search-Users hit to the slim {@link Coworker}. Bitable Sync
// assigns Coworkers by open_id; only the 72px avatar is surfaced in the picker.
export function mapFeishuUserToCoworker(u: FeishuUser): Coworker {
  return {
    openId: u.open_id,
    name: u.name,
    avatarUrl: u.avatar?.avatar_72,
  };
}

// Map a Search-Users response payload to the Coworker list, tolerating an
// absent `users` array (no hits) per the official GET /search/v1/user shape.
export function mapCoworkers(data: { users?: FeishuUser[] }): Coworker[] {
  return (data.users ?? []).map((u) => mapFeishuUserToCoworker(u));
}

// The action HANDLER needs a live runtime (convex-test, opted out per ADR-0018);
// its pure projection (mapCoworkers / mapFeishuUserToCoworker) is unit-tested.
/* v8 ignore start */
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

    return mapCoworkers(data);
  },
});
/* v8 ignore stop */
