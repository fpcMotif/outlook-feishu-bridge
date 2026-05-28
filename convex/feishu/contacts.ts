import { action } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";

// Search Users response (open.feishu.cn GET /open-apis/search/v1/user): each
// user carries open_id, name, an `avatar` object of sized URLs, and
// department_ids. `user_id` is only returned with contact:user.employee_id:readonly,
// which we don't request — forwarding addresses users by open_id. See ADR-0003.
interface FeishuUser {
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

export const searchContacts = action({
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
      label: "Contact search",
    });

    return (data.users ?? []).map((u) => ({
      openId: u.open_id,
      name: u.name,
      avatarUrl: u.avatar?.avatar_72,
    }));
  },
});
