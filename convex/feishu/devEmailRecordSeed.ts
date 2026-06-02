import { v } from "convex/values";

import { mutation } from "../_generated/server";
import { buildRequestSyncKey } from "../emailRecord";
import {
  DEV_EMAIL_FIXTURES,
  submittedAtForDevEmailFixture,
  type DevEmailFixture,
} from "./devEmailFixtures";
import { isDevCustomerFixturesEnabled } from "./devCustomerFixtures";

const DEV_USER_EMAIL = "fanpc@fenchem.com";

function selectedCoworkers(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    return { openId: `ou_dev_fixture_${n}`, name: `Dev Coworker ${n}` };
  });
}

export function buildDevEmailRecordFixture(fixture: DevEmailFixture, now = Date.now()) {
  const syncedAt = submittedAtForDevEmailFixture(fixture, now) ?? now;
  const conversationId = fixture.recordId;
  const requestSyncKey = buildRequestSyncKey(DEV_USER_EMAIL, conversationId);
  return {
    subject: `${fixture.label} date display check`,
    from: "dev.client@example.test",
    clientEmail: "dev.client@example.test",
    to: ["jenny.xu@fenchem.com"],
    cc: [],
    bodyPreview: "DEV fixture Email Record for local success-screen timestamp checks.",
    internetMessageId: `<${fixture.recordId}@dev.fixture.fenchem>`,
    itemId: fixture.recordId,
    conversationId,
    userEmail: DEV_USER_EMAIL,
    ...(requestSyncKey ? { requestSyncKey } : {}),
    dateTimeCreated: syncedAt,
    sentToBot: false,
    sentToChat: false,
    sentToBitable: true,
    requestSelections: [
      { requestType: "Sample", note: "DEV fixture request for timestamp display." },
    ],
    selectedCoworkers: selectedCoworkers(fixture.coworkerCount),
    selectedCustomer: { recordId: "dev_fixture_fanpc_customer", name: "fanpc" },
    initiator: { openId: "ou_dev", name: "Jenny Xu" },
    bitableRecordId: fixture.recordId,
    bitableSyncStatus: "synced" as const,
    bitableLastAttemptAt: syncedAt,
    bitableAttemptCount: 1,
    createdAt: syncedAt,
  };
}

export const seedEmailRecordFixtures = mutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ upserted: number; recordIds: string[] }> => {
    if (!isDevCustomerFixturesEnabled()) {
      throw new Error("Dev email fixtures are disabled for this deployment");
    }

    const rows = DEV_EMAIL_FIXTURES.map((fixture) => buildDevEmailRecordFixture(fixture));
    if (args.dryRun) return { upserted: 0, recordIds: rows.map((row) => row.bitableRecordId) };

    const existingRows = await Promise.all(
      rows.map(async (row) => ({
        row,
        existing: await ctx.db
          .query("emailRecords")
          .withIndex("by_requestSyncKey", (q) => q.eq("requestSyncKey", row.requestSyncKey))
          .unique(),
      })),
    );

    await Promise.all(
      existingRows.map(async ({ row, existing }) => {
        if (existing) {
          await ctx.db.patch(existing._id, row);
          return;
        }
        await ctx.db.insert("emailRecords", row);
      }),
    );

    return { upserted: rows.length, recordIds: rows.map((row) => row.bitableRecordId) };
  },
});
