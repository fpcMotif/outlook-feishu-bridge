import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { sendEmailMessage, attachmentKeyValidator } from "./message";

// Adapter: send to the shared team chat (FEISHU_CHAT_ID) with the tenant token.
export const sendChatMessage = internalAction({
  args: {
    subject: v.string(),
    from: v.string(),
    bodyPreview: v.string(),
    pdfFileKey: v.optional(v.string()),
    attachmentFileKeys: v.optional(v.array(attachmentKeyValidator)),
  },
  handler: (ctx, args): Promise<{ messageId: string }> => {
    const chatId = process.env.FEISHU_CHAT_ID;
    if (!chatId) {
      throw new Error("FEISHU_CHAT_ID must be set");
    }
    return sendEmailMessage(ctx, {
      receiveId: chatId,
      receiveIdType: "chat_id",
      auth: "tenant",
      subject: args.subject,
      from: args.from,
      bodyPreview: args.bodyPreview,
      pdfFileKey: args.pdfFileKey,
      attachmentFileKeys: args.attachmentFileKeys,
    });
  },
});
