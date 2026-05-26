import { action } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";

interface FeishuChat {
  chat_id: string;
  name: string;
  avatar: string;
  description?: string;
  owner_id?: string;
}

export const listUserChats = action({
  args: {
    sessionId: v.string(),
    pageToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const query: Record<string, string> = {
      user_id_type: "open_id",
      page_size: "50",
    };
    if (args.pageToken) {
      query.page_token = args.pageToken;
    }

    const data = await callFeishu<{
      items?: FeishuChat[];
      page_token?: string;
      has_more?: boolean;
    }>(ctx, {
      path: "/im/v1/chats",
      method: "GET",
      query,
      auth: "user",
      sessionId: args.sessionId,
      label: "List chats",
    });

    const chats = (data.items ?? []).map((c) => ({
      chatId: c.chat_id,
      name: c.name,
      avatar: c.avatar,
      description: c.description,
    }));

    return {
      chats,
      pageToken: data.page_token,
      hasMore: data.has_more ?? false,
    };
  },
});
