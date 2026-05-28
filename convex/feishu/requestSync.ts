// Public actions the taskpane calls to sync a sales request into the Bitable
// Service table. These wrap the internal Bitable writes (bitable.ts) and persist
// the email detail to the Convex Email Record. Chat/bot/PDF/Doc are retired
// (ADR-0010); the Bitable row is the only delivery. See ADR-0012.

import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import {
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
  requestSelections: v.optional(v.array(requestSelectionValidator)),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
};

function requireExactlyOneCoworker(coworkers: SelectedCoworker[] | undefined): SelectedCoworker[] {
  if (!coworkers || coworkers.length !== 1) {
    throw new Error("Bitable Sync requires exactly one Feishu coworker");
  }
  return coworkers;
}

// First write: create the Bitable Service row, then store the recoverable Email
// Record (carrying the new bitableRecordId). Returns the recordId so the UI can
// offer the bounded in-sync correction.
export const syncRequest = action({
  args: intakeArgs,
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.createServiceRecord, {
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestSelections: args.requestSelections,
      selectedCoworkers,
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
      },
      { bitableRecordId: recordId },
    );
    await ctx.runMutation(internal.emails.storeEmailRecord, record);
    return { recordId };
  },
});

// Bounded in-sync CORRECTION: re-write the row THIS flow just created. The caller
// must pass the recordId returned by syncRequest in the same session — never a
// pre-existing row (ADR-0012 / the no-touch rule).
export const correctRequest = action({
  args: { recordId: v.string(), ...intakeArgs },
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const selectedCoworkers = requireExactlyOneCoworker(args.selectedCoworkers);
    const { recordId } = await ctx.runAction(internal.feishu.bitable.correctServiceRecord, {
      recordId: args.recordId,
      clientEmail: args.clientEmail ?? args.from,
      clientRecordId: args.selectedCustomer?.recordId,
      dateOfOffer: args.dateTimeCreated,
      requestSelections: args.requestSelections,
      selectedCoworkers,
    });
    return { recordId };
  },
});
