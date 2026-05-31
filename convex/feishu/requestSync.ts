// Public actions the taskpane calls to sync a sales request into the Bitable
// Service table. These wrap the internal Bitable writes (bitable.ts) and persist
// the email detail to the Convex Email Record. Chat/bot/PDF/Doc are retired
// (ADR-0010); the Bitable row is the only delivery. See ADR-0012.

import { action, internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
  initiatorValidator,
  requestSelectionValidator,
  selectedCoworkerValidator,
  selectedCustomerValidator,
  toEmailRecord,
  type SelectedCoworker,
} from "../emailRecord";

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
  requestSelections: v.optional(v.array(requestSelectionValidator)),
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

function buildEmailRecordBackup(
  args: {
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
    requestSelections?: { requestType: string; note: string }[];
    selectedCoworkers?: SelectedCoworker[];
  },
  sentToBitable: boolean,
) {
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
      requestSelections: args.requestSelections,
      selectedCoworkers: args.selectedCoworkers,
      selectedCustomer: args.selectedCustomer,
      initiator: args.initiator,
    },
    { sentToBitable },
  );
}

async function markFailure(
  ctx: { runMutation: (fn: unknown, args: Record<string, unknown>) => Promise<unknown> },
  internetMessageId: string,
  e: unknown,
) {
  await ctx.runMutation(internal.emails.markBitableSyncFailed, {
    internetMessageId,
    error: errorMessage(e),
    attemptedAt: Date.now(),
  });
}

// First write: create the Bitable Service row, then store the recoverable Email
// Record (carrying the new bitableRecordId). Returns the recordId so the UI can
// offer the bounded in-sync correction.
export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const backup = buildEmailRecordBackup({ ...args, selectedCoworkers }, false);
    const beginResult: { bitableClientToken: string; bitableRecordId: string | null } =
      await ctx.runMutation(internal.emails.beginBitableSync, {
        ...backup,
        bitableClientToken: newBitableClientToken(),
      });
    if (beginResult.bitableRecordId) {
      return { recordId: beginResult.bitableRecordId };
    }

    let createdRecordId: string;
    try {
      const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
        subject: args.subject,
        clientEmail: args.clientEmail ?? args.from,
        clientRecordId: args.selectedCustomer?.recordId,
        dateOfOffer: args.dateTimeCreated,
        requestSelections: args.requestSelections,
        selectedCoworkers,
        initiator: args.initiator,
        emailConversationId: args.conversationId,
        clientToken: beginResult.bitableClientToken,
      });
      createdRecordId = recordId;
    } catch (e: unknown) {
      await markFailure(ctx, args.internetMessageId, e);
      throw e;
    }

    try {
      await ctx.runMutation(internal.emails.markBitableSyncSucceeded, {
        internetMessageId: args.internetMessageId,
        bitableRecordId: createdRecordId,
        attemptedAt: Date.now(),
      });
    } catch (e: unknown) {
      console.error(
        `[requestSync] markBitableSyncSucceeded failed; Bitable row ${createdRecordId} ` +
          `will be reconciled with client_token ${beginResult.bitableClientToken}: ${errorMessage(e)}`,
      );
    }
    return { recordId: createdRecordId };
  },
});

export const reconcilePendingBitableSync = internalAction({
  args: {},
  handler: async (ctx): Promise<{ checked: number; synced: number; failed: number }> => {
    const due = await ctx.runQuery(internal.emails.listDueBitableSyncRecords, {
      now: Date.now(),
      limit: RECONCILE_LIMIT,
    });
    let synced = 0;
    let failed = 0;
    for (const record of due) {
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
          requestSelections: record.requestSelections,
          selectedCoworkers,
          initiator: record.initiator,
          emailConversationId: record.conversationId,
          clientToken: record.bitableClientToken,
        });
        await ctx.runMutation(internal.emails.markBitableSyncSucceeded, {
          internetMessageId: record.internetMessageId,
          bitableRecordId: recordId,
          attemptedAt: Date.now(),
        });
        synced += 1;
      } catch (e: unknown) {
        await markFailure(ctx, record.internetMessageId, e);
        failed += 1;
      }
    }
    if (due.length > 0) {
      console.log(
        `[requestSync] reconcilePendingBitableSync checked=${due.length} synced=${synced} failed=${failed}`,
      );
    }
    return { checked: due.length, synced, failed };
  },
});

/* Legacy implementation retained below only for reference in this patch? */
/*
export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
      subject: args.subject,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestSelections: args.requestSelections,
      selectedCoworkers,
      initiator: args.initiator,
      emailConversationId: args.conversationId,
    });
    const record = toEmailRecord(
      {
        subject: args.subject,
        from: args.from,
        to: args.to,
        cc: args.cc,
        body: args.body,
        internetMessageId: args.internetMessageId,
        itemId: args.itemId,
        conversationId: args.conversationId,
        userEmail: args.userEmail,
        dateTimeCreated: args.dateTimeCreated,
        requestSelections: args.requestSelections,
        selectedCoworkers,
        selectedCustomer: args.selectedCustomer,
        initiator: args.initiator,
      },
      { bitableRecordId: recordId },
    );
    // The Bitable row is the record of record; the Email Record is a
    // recoverable backup. If the backup write fails, return the row id so the
    // UI retry path can correct that same row instead of creating a duplicate.
    try {
      await ctx.runMutation(internal.emails.storeEmailRecord, record);
    } catch (e: unknown) {
      console.error(
        `[requestSync] storeEmailRecord failed; Bitable row ${recordId} stands: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    return { recordId };
  },
});
*/

// Bounded in-sync CORRECTION: re-write the row THIS flow just created. The caller
// must pass the recordId returned by syncRequest in the same session — never a
// pre-existing row (ADR-0012 / the no-touch rule).
export const correctRequest = action({
  args: { recordId: v.string(), ...intakeArgs },
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.correctServiceRecord, {
      recordId: args.recordId,
      subject: args.subject,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestSelections: args.requestSelections,
      selectedCoworkers,
      initiator: args.initiator,
      emailConversationId: args.conversationId,
    });
    return { recordId };
  },
});
