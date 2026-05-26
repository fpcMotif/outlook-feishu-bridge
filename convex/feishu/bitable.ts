import { internalAction } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";

export const createRecord = internalAction({
  args: {
    subject: v.string(),
    from: v.string(),
    to: v.array(v.string()),
    bodyPreview: v.string(),
    dateTimeCreated: v.optional(v.number()),
    requestSelections: v.optional(
      v.array(v.object({ requestType: v.string(), note: v.string() })),
    ),
    selectedCoworkers: v.optional(
      v.array(
        v.object({
          openId: v.string(),
          name: v.string(),
          avatarUrl: v.optional(v.string()),
        }),
      ),
    ),
  },
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
    if (!appToken || !tableId) {
      throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
    }

    const data = await callFeishu<{ record?: { record_id: string } }>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      auth: "tenant",
      label: "Bitable create",
      json: {
        fields: {
          Subject: args.subject,
          From: args.from,
          To: args.to.join(", "),
          "Body Preview": args.bodyPreview,
          "Request Types": args.requestSelections?.map((r) => r.requestType).join(", ") ?? "",
          "Request Notes": args.requestSelections
            ?.map((r) => `${r.requestType}: ${r.note}`)
            .join("\n\n") ?? "",
          Coworkers: args.selectedCoworkers?.map((c) => c.name).join(", ") ?? "",
          Date: args.dateTimeCreated ?? Date.now(),
        },
      },
    });

    return { recordId: data.record?.record_id ?? "" };
  },
});
