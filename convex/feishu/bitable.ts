import { action, internalAction, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";
import { requestSelectionValidator, selectedCoworkerValidator } from "../emailRecord";
import type { RequestSelection, SelectedCoworker } from "../emailRecord";

type BitableFields = Record<string, unknown>;
const REQUEST_TYPE_BY_UI_LABEL: Record<string, string> = {
  Quotation: "Qutation",
  Sample: "Sample",
  "R&D Support": "R&D Support",
};

function emailDomain(email: string): string | null {
  const domain = email.split("@")[1]?.trim().toLowerCase();
  return domain || null;
}

function requireBitableTarget() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) {
    throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
  }
  return { appToken, tableId };
}

async function createBitableRecord(
  ctx: ActionCtx,
  fields: BitableFields,
  label: string,
): Promise<{ recordId: string }> {
  const { appToken, tableId } = requireBitableTarget();
  const data = await callFeishu<{ record?: { record_id: string } }>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
    auth: "tenant",
    query: { user_id_type: "open_id" },
    label,
    json: { fields },
  });

  return { recordId: data.record?.record_id ?? "" };
}

export function buildServiceRecordFields(args: {
  clientEmail: string;
  requestSelections: RequestSelection[];
  selectedCoworkers?: SelectedCoworker[];
  salesUser?: SelectedCoworker;
  clientRecordId?: string;
}): BitableFields {
  const domain = emailDomain(args.clientEmail);
  const notes = args.requestSelections
    .map((r) => `${r.requestType}: ${r.note}`)
    .join("\n\n");
  const fields: BitableFields = {
    "Request Remark": [
      `Client email: ${args.clientEmail}`,
      ...(domain ? [`Client domain: ${domain}`] : []),
      "",
      notes,
    ].join("\n"),
    "Request Type": args.requestSelections.map(
      (r) => REQUEST_TYPE_BY_UI_LABEL[r.requestType] ?? r.requestType,
    ),
  };

  if (args.clientRecordId) {
    fields.Client = [args.clientRecordId];
  }

  const coworker = args.selectedCoworkers?.[0];
  if (coworker) {
    fields["Co Worker"] = [{ id: coworker.openId }];
  }

  if (args.salesUser) {
    fields.Sales = [{ id: args.salesUser.openId }];
  }

  for (const request of args.requestSelections) {
    if (request.requestType === "Quotation") fields["Quotation Note"] = request.note;
    if (request.requestType === "Sample") fields["Sample Note"] = request.note;
    if (request.requestType === "R&D Support") fields["R&D Support Note"] = request.note;
  }

  return fields;
}

export const createServiceRecord = action({
  args: {
    requestSelections: v.array(requestSelectionValidator),
    clientEmail: v.string(),
    selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
    salesUser: v.optional(selectedCoworkerValidator),
    clientRecordId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    if (args.requestSelections.length === 0) {
      throw new Error("At least one request selection is required");
    }

    return await createBitableRecord(ctx, buildServiceRecordFields(args), "Bitable create service row");
  },
});

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
    return await createBitableRecord(ctx, {
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
    }, "Bitable create");
  },
});
