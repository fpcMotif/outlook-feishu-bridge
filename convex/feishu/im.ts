import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { sendEmailMessage, attachmentKeyValidator } from "./message";

// Adapter: send to a user's contact (open_id) or group (chat_id) with the user token.
export const sendMessage = internalAction({
  args: {
    sessionId: v.string(),
    receiveId: v.string(),
    receiveIdType: v.union(v.literal("open_id"), v.literal("chat_id")),
    subject: v.string(),
    from: v.string(),
    bodyPreview: v.string(),
    pdfFileKey: v.optional(v.string()),
    attachmentFileKeys: v.optional(v.array(attachmentKeyValidator)),
  },
  handler: (ctx, args): Promise<{ messageId: string }> => {
    return sendEmailMessage(ctx, {
      receiveId: args.receiveId,
      receiveIdType: args.receiveIdType,
      auth: "user",
      sessionId: args.sessionId,
      subject: args.subject,
      from: args.from,
      bodyPreview: args.bodyPreview,
      pdfFileKey: args.pdfFileKey,
      attachmentFileKeys: args.attachmentFileKeys,
    });
  },
});
