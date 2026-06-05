import { action, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  initiatorValidator,
  selectedCoworkerValidator,
  selectedCustomerValidator,
  stagedAttachmentSourceValidator,
  toEmailRecord,
  type SelectedCoworker,
} from "../emailRecord";
import { assertRealCoworkerOpenIds, poisonedOutboxReason } from "./previewFixtures";
import { buildConfiguredBitableRecordDetailUrl } from "./bitableUrl";
import { deleteStagedSources, uploadStagedSourcesToDrive } from "./drive";
import type { Id } from "../_generated/dataModel";

// Shared intake submitted by the taskpane.
const intakeArgs = {
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
  clientEmail: v.optional(v.string()),
  selectedCustomer: v.optional(selectedCustomerValidator),
  selectedSales: v.optional(initiatorValidator),
  initiator: v.optional(initiatorValidator),
  requestNote: v.optional(v.string()),
  // Pre-minted Feishu Drive tokens — the legacy/correction shape. The submit
  // path now sends `attachmentSources` instead (storageIds), so the Drive
  // upload_all runs server-side in the deferred worker (ADR-0022).
  attachments: v.optional(v.array(v.object({ fileToken: v.string() }))),
  // Staged Convex File-Storage refs the deferred Base-write worker uploads to
  // Feishu Drive (upload_all) right before the idempotent create. Persisted on
  // the Email Record backup while pending/failed so retries use exactly the
  // attachments the user selected at submit.
  attachmentSources: v.optional(v.array(stagedAttachmentSourceValidator)),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
};

const RECONCILE_LIMIT = 20;

type SyncRequestResult =
  | { status: "pending"; recordId: null; detailUrl: null }
  | { status: "synced"; recordId: string; detailUrl: string | null };

function newBitableClientToken(): string {
  return globalThis.crypto.randomUUID();
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function requireExactlyOneCoworker(coworkers: SelectedCoworker[] | undefined): SelectedCoworker[] {
  if (!coworkers || coworkers.length !== 1) {
    throw new Error("Bitable Sync requires exactly one Feishu coworker");
  }
  assertRealCoworkerOpenIds(coworkers);
  return coworkers;
}

interface RequestSyncArgs {
  subject: string;
  from: string;
  to: string[];
  cc: string[];
  body: string;
  internetMessageId: string;
  itemId?: string;
  conversationId?: string;
  userEmail?: string;
  dateTimeCreated?: number;
  clientEmail?: string;
  selectedCustomer?: { recordId: string; name: string };
  selectedSales?: { openId: string; name?: string };
  initiator?: { openId: string; name?: string };
  requestNote?: string;
  attachments?: { fileToken: string }[];
  attachmentSources?: { storageId: Id<"_storage">; fileName: string }[];
  selectedCoworkers?: SelectedCoworker[];
}

// Resolve the attachment tokens the create writes. When the submit path handed
// staged storageIds (`attachmentSources`), run the Drive upload_all HERE —
// inside the deferred worker, off the submit critical path — minting tokens just
// before the idempotent create (ADR-0022). uploadStagedSourcesToDrive resolves
// one tenant token and reuses it across every serial Drive upload. Pre-minted
// `attachments` (correction/legacy) pass through unchanged.
async function resolveSyncAttachments(
  ctx: ActionCtx,
  args: RequestSyncArgs,
): Promise<{ fileToken: string }[] | undefined> {
  if (args.attachmentSources && args.attachmentSources.length > 0) {
    const { attachments } = await uploadStagedSourcesToDrive(ctx, args.attachmentSources, {
      deleteAfterUpload: false,
    });
    return attachments;
  }
  return args.attachments;
}

async function cleanupAttachmentSources(
  ctx: ActionCtx,
  sources: RequestSyncArgs["attachmentSources"],
) {
  if (!sources || sources.length === 0) return;
  try {
    await deleteStagedSources(ctx, sources);
  } catch (e: unknown) {
    console.warn(
      `[requestSync] failed to clean staged attachments after successful Bitable row create: ${errorMessage(e)}`,
    );
  }
}

function buildEmailRecordBackup(args: RequestSyncArgs, sentToBitable: boolean) {
  return toEmailRecord(
    {
      subject: args.subject,
      from: args.from,
      clientEmail: args.clientEmail,
      to: args.to,
      cc: args.cc,
      body: args.body,
      internetMessageId: args.internetMessageId,
      itemId: args.itemId,
      conversationId: args.conversationId,
      userEmail: args.userEmail,
      dateTimeCreated: args.dateTimeCreated,
      requestNote: args.requestNote,
      selectedCoworkers: args.selectedCoworkers,
      selectedCustomer: args.selectedCustomer,
      initiator: args.selectedSales ?? args.initiator,
      bitableAttachmentSources: args.attachmentSources,
    },
    { sentToBitable },
  );
}

function resolveSyncSales(args: RequestSyncArgs): RequestSyncArgs["selectedSales"] {
  return args.selectedSales ?? args.initiator;
}

async function markFailure(
  ctx: ActionCtx,
  lookup: { internetMessageId: string; requestSyncKey?: string },
  e: unknown,
) {
  await ctx.runMutation(internal.emails.markBitableSyncFailed, {
    internetMessageId: lookup.internetMessageId,
    requestSyncKey: lookup.requestSyncKey,
    error: errorMessage(e),
    attemptedAt: Date.now(),
  });
}

async function createServiceRow(
  ctx: ActionCtx,
  args: RequestSyncArgs,
  selectedCoworkers: SelectedCoworker[],
  clientToken: string,
): Promise<string> {
  const selectedSales = resolveSyncSales(args);
  const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
    subject: args.subject,
    clientEmail: args.clientEmail ?? args.from,
    clientRecordId: args.selectedCustomer?.recordId,
    dateOfOffer: args.dateTimeCreated,
    requestNote: args.requestNote,
    body: args.body,
    attachments: args.attachments,
    selectedCoworkers,
    selectedSales,
    initiator: selectedSales,
    emailConversationId: args.conversationId,
    clientToken,
  });
  return recordId;
}

async function syncBitableRequest(
  ctx: ActionCtx,
  args: RequestSyncArgs,
  selectedCoworkers: SelectedCoworker[],
  clientToken: string,
): Promise<Extract<SyncRequestResult, { status: "synced" }>> {
  const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
  const createdRecordId = await createServiceRow(ctx, args, selectedCoworkers, clientToken);
  const detailUrl = await markSuccess(ctx, backup, createdRecordId, clientToken);
  return { status: "synced", recordId: createdRecordId, detailUrl };
}

async function markSuccess(
  ctx: ActionCtx,
  backup: ReturnType<typeof buildEmailRecordBackup>,
  bitableRecordId: string,
  clientToken: string,
): Promise<string | null> {
  let detailUrl = buildConfiguredBitableRecordDetailUrl(bitableRecordId);
  try {
    const result: { detailUrl: string | null } = await ctx.runMutation(internal.emails.markBitableSyncSucceeded, {
      internetMessageId: backup.internetMessageId,
      requestSyncKey: backup.requestSyncKey,
      bitableRecordId,
      attemptedAt: Date.now(),
    });
    detailUrl = result.detailUrl;
  } catch (e: unknown) {
    console.error(
      `[requestSync] markBitableSyncSucceeded failed; Bitable row ${bitableRecordId} ` +
        `will be reconciled with client_token ${clientToken}: ${errorMessage(e)}`,
    );
  }
  return detailUrl;
}

export const processPendingBitableSync = internalAction({
  args: { ...intakeArgs, clientToken: v.string() },
  handler: async (ctx, args): Promise<Extract<SyncRequestResult, { status: "synced" }>> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    try {
      // END-TO-END here: stage Convex files -> Drive upload_all -> create row, all
      // in the backend, then the sync continues directly into the create (ADR-0022).
      const attachments = await resolveSyncAttachments(ctx, args);
      const result = await syncBitableRequest(ctx, { ...args, attachments }, selectedCoworkers, args.clientToken);
      await cleanupAttachmentSources(ctx, args.attachmentSources);
      return result;
    } catch (e: unknown) {
      const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
      await markFailure(ctx, backup, e);
      throw e;
    }
  },
});

export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<SyncRequestResult> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
    const poisonReason = poisonedOutboxReason({
      internetMessageId: args.internetMessageId,
      conversationId: args.conversationId,
      selectedCoworkers,
    });
    if (poisonReason) {
      await ctx.runMutation(internal.emails.abandonBitableSync, {
        internetMessageId: backup.internetMessageId,
        requestSyncKey: backup.requestSyncKey,
        error: poisonReason,
        attemptedAt: Date.now(),
      });
      throw new Error(poisonReason);
    }
    const beginResult: { bitableClientToken: string; bitableRecordId: string | null; detailUrl: string | null; shouldSchedule: boolean } =
      await ctx.runMutation(internal.emails.beginBitableSync, {
        ...backup,
        bitableClientToken: newBitableClientToken(),
      });
    if (beginResult.bitableRecordId) {
      return {
        status: "synced",
        recordId: beginResult.bitableRecordId,
        detailUrl: beginResult.detailUrl,
      };
    }

    if (beginResult.shouldSchedule) {
      try {
        await ctx.scheduler.runAfter(0, internal.feishu.requestSync.processPendingBitableSync, {
          ...args,
          selectedCoworkers,
          clientToken: beginResult.bitableClientToken,
        });
      } catch (e: unknown) {
        await markFailure(ctx, backup, e);
        throw e;
      }
    }
    return { status: "pending", recordId: null, detailUrl: null };
  },
});

export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; synced: number; failed: number }> => {
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, { now: Date.now(), limit: RECONCILE_LIMIT });
    const outcomes = await Promise.all(
      due.map(async (record) => {
        const poisonReason = poisonedOutboxReason({
          internetMessageId: record.internetMessageId,
          conversationId: record.conversationId,
          selectedCoworkers: record.selectedCoworkers,
        });
        if (poisonReason) {
          await ctx.runMutation(internal.emails.abandonBitableSync, {
            internetMessageId: record.internetMessageId,
            requestSyncKey: record.requestSyncKey,
            error: poisonReason,
            attemptedAt: Date.now(),
          });
          return "failed" as const;
        }
        try {
          const selectedCoworkers = requireExactlyOneCoworker(record.selectedCoworkers);
          if (!record.bitableClientToken) {
            throw new Error(`Missing bitableClientToken for ${record.internetMessageId}`);
          }
          const replayArgs = {
            subject: record.subject,
            from: record.from,
            to: record.to,
            cc: record.cc,
            body: record.bodyPreview,
            internetMessageId: record.internetMessageId,
            itemId: record.itemId,
            conversationId: record.conversationId,
            userEmail: record.userEmail,
            dateTimeCreated: record.dateTimeCreated,
            clientEmail: record.clientEmail,
            selectedCustomer: record.selectedCustomer,
            selectedSales: record.initiator,
            initiator: record.initiator,
            requestNote: record.requestNote,
            attachmentSources: record.bitableAttachmentSources,
            selectedCoworkers,
          };
          const attachments = await resolveSyncAttachments(ctx, replayArgs);
          const result = await syncBitableRequest(
            ctx,
            { ...replayArgs, attachments },
            selectedCoworkers,
            record.bitableClientToken,
          );
          await cleanupAttachmentSources(ctx, record.bitableAttachmentSources);
          return result.status;
        } catch (e: unknown) {
          await markFailure(ctx, record, e);
          return "failed" as const;
        }
      }),
    );
    const synced = outcomes.filter((o) => o === "synced").length;
    const failed = outcomes.filter((o) => o === "failed").length;
    if (due.length > 0) {
      console.log(
        `[requestSync] reconcilePendingBitableSync checked=${due.length} synced=${synced} failed=${failed}`,
      );
    }
    return { checked: due.length, synced, failed };
  },
});

export const correctRequest = action({
  args: { recordId: v.string(), ...intakeArgs },
  handler: async (ctx, args): Promise<{ recordId: string; detailUrl: string | null }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const attachments = await resolveSyncAttachments(ctx, args);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.correctServiceRecord, {
      recordId: args.recordId,
      subject: args.subject,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestNote: args.requestNote,
      body: args.body,
      attachments,
      selectedCoworkers,
      selectedSales: resolveSyncSales(args),
      initiator: resolveSyncSales(args),
      emailConversationId: args.conversationId,
    });
    await cleanupAttachmentSources(ctx, args.attachmentSources);
    return { recordId, detailUrl: buildConfiguredBitableRecordDetailUrl(recordId) };
  },
});
