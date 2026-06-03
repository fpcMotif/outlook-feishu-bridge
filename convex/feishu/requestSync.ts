// Public actions the taskpane calls to sync a sales request into the Bitable
// Service table. These wrap the internal Bitable writes (bitable.ts) and persist
// the email detail to the Convex Email Record. Chat/bot/PDF/Doc are retired
// (ADR-0010); the Bitable row is the only delivery. See ADR-0012.

import { action, internalAction, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  initiatorValidator,
  selectedCoworkerValidator,
  selectedCustomerValidator,
  toEmailRecord,
  type SelectedCoworker,
} from "../emailRecord";
import { buildConfiguredBitableRecordDetailUrl } from "./bitableUrl";

// Shared intake the UI submits. `clientEmail` is the user-confirmed client email
// used for the legacy backend domain-match against the Customer Table;
// `selectedCustomer` is the SPA-side Customer Picker override (ADR-0013) — when
// present it wins, otherwise the domain match runs as before. `from` is the
// actual sender stored on the Email Record. Email subject/body live only on
// the Convex Email Record.
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
  initiator: v.optional(initiatorValidator),
  // ADR-0022: the SPA now submits one consolidated note instead of the per-
  // category requestSelections. `body` (already above) rides to the Base too.
  requestNote: v.optional(v.string()),
  // ADR-0022: Feishu Drive file_tokens minted by uploadAttachmentsToDrive before
  // the sync; written to the Base Attachment cell on create.
  attachments: v.optional(v.array(v.object({ fileToken: v.string() }))),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
};

const RECONCILE_LIMIT = 20;

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
  initiator?: { openId: string; name?: string };
  requestNote?: string;
  attachments?: { fileToken: string }[];
  selectedCoworkers?: SelectedCoworker[];
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
      initiator: args.initiator,
    },
    { sentToBitable },
  );
}

async function markFailure(
  ctx: ActionCtx,
  lookup: { internetMessageId: string; requestSyncKey?: string },
  e: unknown,
) {
  // Forward ONLY the two lookup keys. Callers pass whole objects — the reconcile
  // path passes a full `emailRecords` doc (with `_creationTime`/`_id`/`bodyPreview`/…)
  // and syncRequest passes the `backup` (subject/from/…). Spreading those tripped
  // markBitableSyncFailed's validator with `extra field _creationTime`.
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
  const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
    subject: args.subject,
    clientEmail: args.clientEmail ?? args.from,
    clientRecordId: args.selectedCustomer?.recordId,
    dateOfOffer: args.dateTimeCreated,
    requestNote: args.requestNote,
    body: args.body,
    attachments: args.attachments,
    selectedCoworkers,
    initiator: args.initiator,
    emailConversationId: args.conversationId,
    clientToken,
  });
  return recordId;
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

// First write: create the Bitable Service row, then store the recoverable Email
// Record (carrying the new bitableRecordId). Returns the record id and Feishu
// detail link so later edits happen in Base, not in the add-in.
export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<{ recordId: string; detailUrl: string | null }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
    const beginResult: {
      bitableClientToken: string;
      bitableRecordId: string | null;
      detailUrl: string | null;
    } =
      await ctx.runMutation(internal.emails.beginBitableSync, {
        ...backup,
        bitableClientToken: newBitableClientToken(),
      });
    if (beginResult.bitableRecordId) {
      return { recordId: beginResult.bitableRecordId, detailUrl: beginResult.detailUrl };
    }

    let createdRecordId: string;
    try {
      createdRecordId = await createServiceRow(
        ctx,
        args,
        selectedCoworkers,
        beginResult.bitableClientToken,
      );
    } catch (e: unknown) {
      await markFailure(ctx, backup, e);
      throw e;
    }

    const detailUrl = await markSuccess(
      ctx,
      backup,
      createdRecordId,
      beginResult.bitableClientToken,
    );
    return { recordId: createdRecordId, detailUrl };
  },
});

export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; synced: number; failed: number }> => {
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, {
      now: Date.now(),
      limit: RECONCILE_LIMIT,
    });
    const outcomes = await Promise.all(
      due.map(async (record) => {
        try {
          const selectedCoworkers = requireExactlyOneCoworker(record.selectedCoworkers);
          if (!record.bitableClientToken) {
            throw new Error(`Missing bitableClientToken for ${record.internetMessageId}`);
          }
          const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
            subject: record.subject,
            clientEmail: record.clientEmail ?? record.from,
            clientRecordId: record.selectedCustomer?.recordId,
            dateOfOffer: record.dateTimeCreated,
            requestNote: record.requestNote,
            // ADR-0022: only the stored ≤500-char preview is available on retry —
            // the full body is never persisted on the backup.
            body: record.bodyPreview,
            selectedCoworkers,
            initiator: record.initiator,
            emailConversationId: record.conversationId,
            clientToken: record.bitableClientToken,
          });
          await ctx.runMutation(internal.emails.markBitableSyncSucceeded, {
            internetMessageId: record.internetMessageId,
            requestSyncKey: record.requestSyncKey,
            bitableRecordId: recordId,
            attemptedAt: Date.now(),
          });
          return "synced" as const;
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

// Bounded in-sync CORRECTION: re-write the row THIS flow just created. The caller
// must pass the recordId returned by syncRequest in the same session — never a
// pre-existing row (ADR-0012 / the no-touch rule).
export const correctRequest = action({
  args: { recordId: v.string(), ...intakeArgs },
  handler: async (ctx, args): Promise<{ recordId: string; detailUrl: string | null }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.correctServiceRecord, {
      recordId: args.recordId,
      subject: args.subject,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestNote: args.requestNote,
      body: args.body,
      attachments: args.attachments,
      selectedCoworkers,
      initiator: args.initiator,
      emailConversationId: args.conversationId,
    });
    return { recordId, detailUrl: buildConfiguredBitableRecordDetailUrl(recordId) };
  },
});
