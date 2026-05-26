// Deep module: send an email as a Feishu interactive-card message to a receiver,
// then follow up with the PDF and any attachments. The receiver (id + type +
// token kind) is the only thing that varies — chat.ts and im.ts are thin
// adapters over this. Card layout and follow-up ordering live here, once.

import type { ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu, resolveFeishuToken } from "./call";

export const attachmentKeyValidator = v.object({
  fileKey: v.string(),
  fileName: v.string(),
  type: v.union(v.literal("file"), v.literal("image")),
});

type AttachmentKey = { fileKey: string; fileName: string; type: "file" | "image" };

export interface EmailMessageTarget {
  receiveId: string;
  receiveIdType: "open_id" | "chat_id";
  auth: "tenant" | "user";
  sessionId?: string;
}

export interface EmailMessageContent {
  subject: string;
  from: string;
  bodyPreview: string;
  pdfFileKey?: string;
  attachmentFileKeys?: AttachmentKey[];
}

function emailCard(subject: string, from: string, bodyPreview: string): string {
  return JSON.stringify({
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `Email: ${subject}` },
      template: "blue",
    },
    elements: [
      { tag: "div", text: { tag: "plain_text", content: `From: ${from}` } },
      { tag: "div", text: { tag: "plain_text", content: bodyPreview } },
    ],
  });
}

/** One message to the receiver, reusing the caller's pre-resolved token. */
function postMessage(
  ctx: ActionCtx,
  target: EmailMessageTarget,
  token: string,
  msgType: "interactive" | "file" | "image",
  content: string,
) {
  return callFeishu<{ message_id?: string }>(ctx, {
    path: "/im/v1/messages",
    query: { receive_id_type: target.receiveIdType },
    auth: target.auth,
    sessionId: target.sessionId,
    token,
    label: "Send message",
    json: { receive_id: target.receiveId, msg_type: msgType, content },
  });
}

export async function sendEmailMessage(
  ctx: ActionCtx,
  args: EmailMessageTarget & EmailMessageContent,
): Promise<{ messageId: string }> {
  // Resolve once: a single forward can fan out to many follow-up messages.
  const tStart = Date.now();
  const token = await resolveFeishuToken(ctx, args.auth, args.sessionId);

  const main = await postMessage(
    ctx, args, token, "interactive", emailCard(args.subject, args.from, args.bodyPreview),
  );
  const tCard = Date.now();

  // The card must land first (awaited above). The PDF and attachment follow-ups
  // are independent of each other, so fire them concurrently. They are dispatched
  // in order (pdf, then attachments) but their network round-trips overlap.
  const followUps: Promise<unknown>[] = [];
  if (args.pdfFileKey) {
    followUps.push(postMessage(ctx, args, token, "file", JSON.stringify({ file_key: args.pdfFileKey })));
  }
  for (const att of args.attachmentFileKeys ?? []) {
    const isImage = att.type === "image";
    const content = isImage ? { image_key: att.fileKey } : { file_key: att.fileKey };
    followUps.push(postMessage(ctx, args, token, isImage ? "image" : "file", JSON.stringify(content)));
  }
  await Promise.all(followUps);

  console.log(
    `[forward.send] ${args.receiveIdType} card ${tCard - tStart}ms, follow-ups ${Date.now() - tCard}ms, total ${Date.now() - tStart}ms`,
  );
  return { messageId: main.message_id ?? "" };
}
