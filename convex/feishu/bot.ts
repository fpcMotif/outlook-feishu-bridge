import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { feishuFetch } from "./client";

export const sendBotWebhook = internalAction({
  args: {
    subject: v.string(),
    from: v.string(),
    bodyPreview: v.string(),
  },
  handler: async (_ctx, args): Promise<{ success: boolean }> => {
    const webhookUrl = process.env.FEISHU_BOT_WEBHOOK_URL;
    if (!webhookUrl) {
      throw new Error("FEISHU_BOT_WEBHOOK_URL must be set");
    }

    await feishuFetch({
      url: webhookUrl,
      acceptStatusCode: true,
      label: "Bot webhook",
      json: {
        msg_type: "interactive",
        card: {
          header: {
            title: { tag: "plain_text", content: `New Email: ${args.subject}` },
            template: "blue",
          },
          elements: [
            { tag: "div", text: { tag: "plain_text", content: `From: ${args.from}` } },
            { tag: "div", text: { tag: "plain_text", content: args.bodyPreview } },
          ],
        },
      },
    });

    return { success: true };
  },
});
