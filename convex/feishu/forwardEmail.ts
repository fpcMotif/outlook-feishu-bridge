import { action, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";

const attachmentKeyValidator = v.object({
  fileKey: v.string(),
  fileName: v.string(),
  type: v.union(v.literal("file"), v.literal("image")),
});

export const forwardToFeishu = action({
  args: {
    subject: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    cc: v.array(v.string()),
    body: v.string(),
    internetMessageId: v.string(),
    itemId: v.optional(v.string()),
    conversationId: v.optional(v.string()),
    userEmail: v.optional(v.string()),
    dateTimeCreated: v.optional(v.number()),
    targets: v.object({
      bot: v.boolean(),
      chat: v.boolean(),
      bitable: v.boolean(),
    }),
    sessionId: v.optional(v.string()),
    contacts: v.optional(v.array(v.string())),
    groups: v.optional(v.array(v.string())),
    // The PDF arrives as bytes (small) or a storageId (large); this action
    // uploads it to Feishu, so the client skips a separate upload round-trip.
    pdfBytes: v.optional(v.bytes()),
    pdfStorageId: v.optional(v.id("_storage")),
    attachmentFileKeys: v.optional(v.array(attachmentKeyValidator)),
    feishuDocUrl: v.optional(v.string()),
    feishuDocToken: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const tStart = Date.now();
    const bodyPreview = args.body.slice(0, 500);
    const emailMeta = { subject: args.subject, from: args.from, bodyPreview };

    // Upload the PDF to Feishu here (one CN→US round-trip for the whole forward).
    // Best-effort: a PDF failure must not strand the card / attachments / Doc.
    let pdfFileKey: string | undefined;
    if (args.pdfBytes || args.pdfStorageId) {
      try {
        const r: { fileKey: string } = await ctx.runAction(internal.feishu.pdf.uploadPdfToFeishu, {
          fileName: `${args.subject}.pdf`,
          pdfBytes: args.pdfBytes,
          storageId: args.pdfStorageId,
        });
        pdfFileKey = r.fileKey || undefined;
      } catch (e) {
        console.error(`[forward] PDF upload failed, forwarding without it: ${String(e)}`);
      }
    }
    const tPdf = Date.now();

    const ids = await dispatchToTargets(ctx, args, emailMeta, pdfFileKey);
    const tDispatch = Date.now();

    await storeRecord(ctx, args, bodyPreview, ids, pdfFileKey);
    console.log(
      `[forward] pdfUpload ${tPdf - tStart}ms, dispatch ${tDispatch - tPdf}ms, storeRecord ${Date.now() - tDispatch}ms, total ${Date.now() - tStart}ms`,
    );

    return { ...ids, feishuDocUrl: args.feishuDocUrl };
  },
});

async function dispatchToTargets(
  ctx: ActionCtx,
  args: { targets: { bot: boolean; chat: boolean; bitable: boolean }; to: string[]; dateTimeCreated?: number; attachmentFileKeys?: { fileKey: string; fileName: string; type: "file" | "image" }[]; feishuDocUrl?: string; sessionId?: string; contacts?: string[]; groups?: string[] },
  emailMeta: { subject: string; from: string; bodyPreview: string },
  pdfFileKey: string | undefined,
) {
  // Independent receivers (bot webhook, team chat, Bitable, contacts, groups)
  // fan out concurrently. Each receiver's card-first ordering is preserved inside
  // sendEmailMessage; only cross-receiver ordering (irrelevant) changes.
  let feishuMessageId: string | undefined;
  let bitableRecordId: string | undefined;
  const tasks: Promise<unknown>[] = [];

  if (args.targets.bot) {
    tasks.push(ctx.runAction(internal.feishu.bot.sendBotWebhook, emailMeta));
  }

  if (args.targets.chat) {
    const chatMeta = args.feishuDocUrl
      ? { ...emailMeta, bodyPreview: `${emailMeta.bodyPreview}\n\nFeishu Doc: ${args.feishuDocUrl}` }
      : emailMeta;
    tasks.push(
      ctx.runAction(internal.feishu.chat.sendChatMessage, {
        ...chatMeta,
        pdfFileKey,
        attachmentFileKeys: args.attachmentFileKeys,
      }).then((result: { messageId: string }) => {
        feishuMessageId = result.messageId;
      }),
    );
  }

  if (args.targets.bitable) {
    tasks.push(
      ctx.runAction(internal.feishu.bitable.createRecord, {
        ...emailMeta,
        to: args.to,
        dateTimeCreated: args.dateTimeCreated,
      }).then((result: { recordId: string }) => {
        bitableRecordId = result.recordId;
      }),
    );
  }

  tasks.push(sendToContactsAndGroups(ctx, args, emailMeta, pdfFileKey));

  await Promise.all(tasks);

  return { feishuMessageId, bitableRecordId };
}

async function storeRecord(
  ctx: ActionCtx,
  args: {
    subject: string; from: string; to: string[]; cc: string[];
    internetMessageId: string; itemId?: string; conversationId?: string;
    userEmail?: string; dateTimeCreated?: number;
    targets: { bot: boolean; chat: boolean; bitable: boolean };
    contacts?: string[]; groups?: string[];
    attachmentFileKeys?: { fileKey: string; fileName: string; type: "file" | "image" }[];
    feishuDocUrl?: string; feishuDocToken?: string;
  },
  bodyPreview: string,
  ids: { feishuMessageId?: string; bitableRecordId?: string },
  pdfFileKey: string | undefined,
) {
  await ctx.runMutation(internal.emails.storeEmailRecord, {
    subject: args.subject,
    from: args.from,
    to: args.to,
    cc: args.cc,
    bodyPreview,
    internetMessageId: args.internetMessageId,
    itemId: args.itemId,
    conversationId: args.conversationId,
    userEmail: args.userEmail,
    dateTimeCreated: args.dateTimeCreated,
    sentToBot: args.targets.bot,
    sentToChat: args.targets.chat,
    sentToBitable: args.targets.bitable,
    sentToContacts: args.contacts,
    sentToGroups: args.groups,
    feishuMessageId: ids.feishuMessageId,
    bitableRecordId: ids.bitableRecordId,
    pdfFileKey,
    attachmentFileKeys: args.attachmentFileKeys,
    feishuDocUrl: args.feishuDocUrl,
    feishuDocToken: args.feishuDocToken,
  });
}

async function sendToContactsAndGroups(
  ctx: ActionCtx,
  args: {
    sessionId?: string;
    contacts?: string[];
    groups?: string[];
    attachmentFileKeys?: { fileKey: string; fileName: string; type: "file" | "image" }[];
  },
  emailMeta: { subject: string; from: string; bodyPreview: string },
  pdfFileKey: string | undefined,
) {
  if (!args.sessionId) return;
  const imArgs = {
    sessionId: args.sessionId,
    ...emailMeta,
    pdfFileKey,
    attachmentFileKeys: args.attachmentFileKeys,
  };

  // Each contact/group is an independent receiver — send to all concurrently.
  const sends: Promise<unknown>[] = [];
  for (const openId of args.contacts ?? []) {
    sends.push(ctx.runAction(internal.feishu.im.sendMessage, {
      ...imArgs,
      receiveId: openId,
      receiveIdType: "open_id" as const,
    }));
  }
  for (const chatId of args.groups ?? []) {
    sends.push(ctx.runAction(internal.feishu.im.sendMessage, {
      ...imArgs,
      receiveId: chatId,
      receiveIdType: "chat_id" as const,
    }));
  }
  await Promise.all(sends);
}
