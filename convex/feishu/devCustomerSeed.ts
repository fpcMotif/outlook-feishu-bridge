import { v } from "convex/values";

import { mutation } from "../_generated/server";
import { projectionToRow } from "./customerMirrorRows";
import {
  DEV_CUSTOMER_FIXTURES,
  isDevCustomerFixturesEnabled,
} from "./devCustomerFixtures";

export const seedCustomerFixtures = mutation({
  args: { dryRun: v.optional(v.boolean()) },
  handler: async (ctx, args): Promise<{ upserted: number; recordIds: string[] }> => {
    if (!isDevCustomerFixturesEnabled()) {
      throw new Error("Dev customer fixtures are disabled for this deployment");
    }
    const mirroredAt = Date.now();
    const rows = DEV_CUSTOMER_FIXTURES.map((customer) => projectionToRow(customer));
    if (args.dryRun) return { upserted: 0, recordIds: rows.map((row) => row.recordId) };

    const existingRows = await Promise.all(
      rows.map(async (row) => ({
        row,
        existing: await ctx.db
          .query("customers")
          .withIndex("by_recordId", (q) => q.eq("recordId", row.recordId))
          .unique(),
      })),
    );
    await Promise.all(
      existingRows.map(async ({ row, existing }) => {
        const fields = { ...row, mirroredAt };
        if (existing) {
          await ctx.db.patch(existing._id, fields);
          return;
        }
        await ctx.db.insert("customers", fields);
      }),
    );
    return { upserted: rows.length, recordIds: rows.map((row) => row.recordId) };
  },
});
