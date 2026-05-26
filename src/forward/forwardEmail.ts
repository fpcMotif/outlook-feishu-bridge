// Deep module: orchestrate forwarding the current mail item to Feishu —
// PDF generation, attachment uploads, doc creation, the forward call, and the
// "Sent to Feishu" category. Every Convex action and Office reader it needs is
// injected via ForwardDeps, so the whole sequence is testable with fakes and
// without rendering React. TaskPane just builds the deps and calls forwardEmail.

import type { Id } from "../../convex/_generated/dataModel";
import type { MailItemData, AttachmentInfo } from "../office/useMailItem";
import type { ForwardTargets } from "./targets";
import { dlog, dtime } from "../debug";
import { putBlobInStorage, uploadOneAttachment, uploadDocAttachments } from "./uploads";

// Feishu IM (/im/v1/files) caps an inline chat file at 30 MB. The Feishu Doc
// embeds media via Drive (chunked upload supported), so doc attachments can be
// larger — bounded in practice by Outlook's own attachment-read limit. ADR-0004.
const FEISHU_IM_MAX_FILE_SIZE = 30 * 1024 * 1024;
const DOC_ATTACHMENT_MAX = 50 * 1024 * 1024;
// A PDF at or below this rides inline as a `pdfBytes` arg (one round-trip);
// larger ones stage via storage to stay under the 5 MiB Node-action arg cap.
// A text-only email PDF is a few KB, so the common path skips staging entirely.
const PDF_INLINE_MAX = 4 * 1024 * 1024;

export type StorageId = Id<"_storage">;
export type DocMedia = { storageId: StorageId; fileName: string };
export type AttachmentKey = { fileKey: string; fileName: string; type: "file" | "image" };

export interface ForwardExtras {
  // The PDF rides to the forward action as bytes (small) or a storageId (large);
  // the action uploads it to Feishu server-side, collapsing a CN→US round-trip.
  pdfBytes?: ArrayBuffer;
  pdfStorageId?: StorageId;
  attachmentFileKeys?: AttachmentKey[];
  feishuDocUrl?: string;
  feishuDocToken?: string;
}

// What the user asked to forward vs what actually got prepared. Lets us catch
// "missing behavior" — silent gaps that throw no error (a best-effort PDF that
// was skipped, attachments dropped). Reported per forward so Sentry can alert
// when delivered < requested. See ADR-0006.
export interface ForwardOutcome {
  pdf: { requested: boolean; delivered: boolean };
  attachments: { requested: number; delivered: number; oversize: number };
  doc: { requested: boolean; delivered: boolean };
}

// The seam: the Convex actions + Office readers + progress sink the
// orchestration depends on. Real ones come from hooks; tests pass fakes.
export interface ForwardDeps {
  getAttachmentContent: (id: string) => Promise<{ format: string; content: string }>;
  generateUploadUrl: () => Promise<string>;
  uploadAttachment: (a: { storageId: StorageId; fileName: string; contentType: string }) => Promise<{ fileKey: string }>;
  uploadImage: (a: { storageId: StorageId; fileName: string; contentType: string }) => Promise<{ imageKey: string }>;
  createDoc: (a: {
    markdown: string;
    title: string;
    imageStorageIds?: DocMedia[];
    fileStorageIds?: DocMedia[];
  }) => Promise<{ docUrl: string; docToken: string }>;
  forwardToFeishu: (
    args: ReturnType<typeof buildForwardArgs> & ForwardExtras,
  ) => Promise<{ feishuDocUrl?: string }>;
  generatePdf: (subject: string, body: string) => Promise<ArrayBuffer>;
  generateMarkdown: (
    subject: string,
    from: string,
    to: string[],
    cc: string[],
    date?: Date,
  ) => Promise<string>;
  applyFeishuCategory: () => Promise<unknown>;
  onProgress: (msg: string) => void;
  // Optional sink for the requested-vs-delivered summary (wired to Sentry in the
  // app; omitted in tests). Called once per forward, after it completes.
  onOutcome?: (outcome: ForwardOutcome) => void;
}

function buildForwardArgs(item: MailItemData, targets: ForwardTargets, sid?: string) {
  return {
    subject: item.subject,
    from: item.from,
    to: item.to,
    cc: item.cc,
    body: item.body,
    internetMessageId: item.internetMessageId,
    itemId: item.itemId || undefined,
    conversationId: item.conversationId || undefined,
    userEmail: item.userEmail || undefined,
    dateTimeCreated: item.dateTimeCreated?.getTime(),
    targets: { bot: targets.bot, chat: targets.chat, bitable: targets.bitable },
    sessionId: sid,
    contacts: targets.contacts.length > 0 ? targets.contacts : undefined,
    groups: targets.groups.length > 0 ? targets.groups : undefined,
  };
}

async function prepareFeishuDoc(
  deps: ForwardDeps,
  mailItem: MailItemData,
  includeAttachments?: boolean,
) {
  deps.onProgress("Creating Feishu Doc...");
  const eligible = mailItem.attachments.filter((a) => a.size <= DOC_ATTACHMENT_MAX);
  const inlineImages = eligible.filter((a) => a.isInline && a.contentType.startsWith("image/"));
  const docFiles = includeAttachments ? eligible.filter((a) => !a.isInline) : [];

  // Markdown conversion and media staging are independent — run concurrently.
  const [markdown, imageStorageIds, fileStorageIds] = await Promise.all([
    deps.generateMarkdown(
      mailItem.subject, mailItem.from, mailItem.to, mailItem.cc, mailItem.dateTimeCreated ?? undefined,
    ),
    inlineImages.length > 0 ? uploadDocAttachments(deps, inlineImages, "image") : Promise.resolve<DocMedia[]>([]),
    docFiles.length > 0 ? uploadDocAttachments(deps, docFiles, "file") : Promise.resolve<DocMedia[]>([]),
  ]);

  return await deps.createDoc({
    markdown,
    title: mailItem.subject,
    ...(imageStorageIds.length > 0 ? { imageStorageIds } : {}),
    ...(fileStorageIds.length > 0 ? { fileStorageIds } : {}),
  });
}

// "Don't omit" — surface attachments too big to send inline to a chat instead
// of silently dropping them. If a Doc is being created, they ride along there.
function noteOversizeForChat(deps: ForwardDeps, attachments: AttachmentInfo[], createDoc: boolean): void {
  const oversize = attachments.filter((a) => a.size > FEISHU_IM_MAX_FILE_SIZE);
  if (oversize.length === 0) return;
  const where = createDoc ? " — included in the Feishu Doc instead" : "";
  deps.onProgress(
    `Note: ${oversize.length} attachment(s) over 30MB can't go inline to the chat${where}: ${oversize.map((a) => a.name).join(", ")}`,
  );
}

type PdfPayload = Pick<ForwardExtras, "pdfBytes" | "pdfStorageId">;

async function preparePdf(deps: ForwardDeps, mailItem: MailItemData): Promise<PdfPayload> {
  deps.onProgress("Generating PDF...");
  const tGen = performance.now();
  // Reuse the already-read mail body — no second Office body.getAsync round-trip.
  const pdfBytes = await deps.generatePdf(mailItem.subject, mailItem.body);
  dtime(`PDF gen (${pdfBytes.byteLength}B)`, tGen);
  // A few-KB text PDF rides to the forward action inline as bytes (the action
  // uploads it to Feishu server-side — no separate client round-trip). Only a
  // large PDF stages via storage first, to stay under the 5 MiB arg cap (ADR-0004).
  if (pdfBytes.byteLength <= PDF_INLINE_MAX) return { pdfBytes };
  deps.onProgress("Staging large PDF...");
  const tStage = performance.now();
  const pdfStorageId = await putBlobInStorage(
    deps, new Blob([pdfBytes], { type: "application/pdf" }), "application/pdf", "large PDF",
  );
  dtime("PDF stage (large)", tStage);
  return { pdfStorageId };
}

async function prepareAttachments(
  deps: ForwardDeps,
  mailItem: MailItemData,
  createDoc: boolean,
): Promise<AttachmentKey[]> {
  noteOversizeForChat(deps, mailItem.attachments, createDoc);
  const eligible = mailItem.attachments.filter((a) => a.size <= FEISHU_IM_MAX_FILE_SIZE);
  deps.onProgress(`Uploading ${eligible.length} attachment(s)...`);
  const tAtt = performance.now();
  // Independent uploads race; Promise.all preserves input order in its result,
  // so attachmentFileKeys stays deterministic regardless of completion order.
  const keys = await Promise.all(eligible.map((att) => uploadOneAttachment(deps, att)));
  dtime(`attachments total (${eligible.length})`, tAtt);
  return keys;
}

async function prepareForwardExtras(
  deps: ForwardDeps,
  mailItem: MailItemData,
  targets: ForwardTargets,
): Promise<ForwardExtras> {
  // PDF, attachment, and Feishu-Doc preparation are independent — run them
  // concurrently so PDF gen/CPU overlaps attachment + doc network I/O, instead
  // of paying for each segment in series.
  const hasAttachments = targets.includeAttachments && mailItem.attachments.length > 0;
  const [pdf, attachmentKeys, docResult] = await Promise.all([
    // Best-effort: a PDF failure must not strand the whole forward — log it and
    // forward the rest (card + attachments + Doc).
    targets.attachPdf
      ? preparePdf(deps, mailItem).catch((e: unknown): PdfPayload => {
          dlog(`PDF failed — forwarding without it: ${e instanceof Error ? e.message : String(e)}`);
          deps.onProgress("PDF generation failed — forwarding without the PDF.");
          return {};
        })
      : ({} as PdfPayload),
    hasAttachments ? prepareAttachments(deps, mailItem, targets.createDoc) : undefined,
    targets.createDoc ? prepareFeishuDoc(deps, mailItem, targets.includeAttachments) : undefined,
  ]);

  return {
    pdfBytes: pdf.pdfBytes,
    pdfStorageId: pdf.pdfStorageId,
    attachmentFileKeys: attachmentKeys?.length ? attachmentKeys : undefined,
    feishuDocUrl: docResult?.docUrl,
    feishuDocToken: docResult?.docToken,
  };
}

function computeForwardOutcome(
  mailItem: MailItemData,
  targets: ForwardTargets,
  extras: ForwardExtras,
): ForwardOutcome {
  const atts = targets.includeAttachments ? mailItem.attachments : [];
  return {
    pdf: { requested: targets.attachPdf, delivered: Boolean(extras.pdfBytes ?? extras.pdfStorageId) },
    attachments: {
      requested: atts.length,
      delivered: extras.attachmentFileKeys?.length ?? 0,
      oversize: atts.filter((a) => a.size > FEISHU_IM_MAX_FILE_SIZE).length,
    },
    doc: { requested: targets.createDoc, delivered: Boolean(extras.feishuDocUrl ?? extras.feishuDocToken) },
  };
}

/** Orchestrate the full forward: build extras, forward, then tag the email. */
export async function forwardEmail(
  deps: ForwardDeps,
  mailItem: MailItemData,
  targets: ForwardTargets,
  sessionId: string,
): Promise<void> {
  const T0 = performance.now();
  dlog(`▶ forward start: ${mailItem.attachments.length} attachment(s)`);
  const tExtras = performance.now();
  const extras = await prepareForwardExtras(deps, mailItem, targets);
  dtime("extras prep (pdf+attachments+doc)", tExtras);
  deps.onProgress("Forwarding to Feishu...");
  const tFwd = performance.now();
  await deps.forwardToFeishu({ ...buildForwardArgs(mailItem, targets, sessionId), ...extras });
  dtime("forwardToFeishu action", tFwd);
  const tCat = performance.now();
  await deps.applyFeishuCategory();
  dtime("applyFeishuCategory", tCat);
  deps.onOutcome?.(computeForwardOutcome(mailItem, targets, extras));
  dtime("T_total (forwardEmail entry→done)", T0);
}
