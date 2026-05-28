import { internalAction, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";
import { buildServiceFields, type ServiceRowInput } from "./serviceRow";

// Bitable record writes for the sales "Service" table. Endpoints + field-value
// formats come from the official Feishu docs (the ONLY source of truth):
//   create  POST /bitable/v1/apps/{app}/tables/{table}/records
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
//   update  PUT  /bitable/v1/apps/{app}/tables/{table}/records/{record_id}
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update
//   search  POST /bitable/v1/apps/{app}/tables/{table}/records/search
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
// Field-value SHAPES (and how this file maps the SPA intake to them) live in
// `serviceRow.ts` — the pure module that is unit-tested. This file only owns
// the env config, the Customer-Table lookup (read-only), and the HTTP path.
// HARD RULE (ADR-0010 / ADR-0012): never modify or delete a PRE-EXISTING row. We
// only CREATE new rows and may correction-UPDATE a row THIS flow just created; the
// customer table is only ever READ (searched).

// Customer table the main "Client" DuplexLink points at, and its email-domain
// Text field (found via list-fields). Domain matching is intentionally simple —
// the richer match rules are on-going development and slot into matchClientRecordId.
const CLIENT_TABLE_ID = "tbl4TE2GV472sKzp";
const CLIENT_DOMAIN_FIELD = "域名";

const requestSelectionValidator = v.object({ requestType: v.string(), note: v.string() });
const coworkerValidator = v.object({
  openId: v.string(),
  name: v.string(),
  avatarUrl: v.optional(v.string()),
});
const initiatorValidator = v.object({
  openId: v.string(),
  name: v.optional(v.string()),
});

// Shared write args. The client is the email sender; if `clientRecordId` is
// passed (the salesperson's override picked from the Customer Picker, ADR-0013)
// we use it directly. Otherwise we fall back to the legacy email-domain match
// against the Customer Table. `subject` + `initiator` are written into the
// row's `Email Subject` and `Sales` columns respectively (ADR-0014); the email
// BODY is NOT written here — that stays preview-only on the Email Record
// (ADR-0010 still holds for body).
const serviceRowArgs = {
  subject: v.optional(v.string()),
  clientEmail: v.optional(v.string()),
  clientRecordId: v.optional(v.string()),
  dateOfOffer: v.optional(v.number()),
  requestSelections: v.optional(v.array(requestSelectionValidator)),
  selectedCoworkers: v.optional(v.array(coworkerValidator)),
  initiator: v.optional(initiatorValidator),
};

function requireBitableEnv() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) {
    throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
  }
  return { appToken, tableId };
}

function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at < 0) return null;
  const domain = email.slice(at + 1).trim().toLowerCase();
  return domain || null;
}

// READ-ONLY. Resolve a customer record_id by the email's domain (域名), or null.
// Lenient by design: no domain / no match -> null (Client left unlinked, the email
// stays on the Convex Email Record). Richer rules are on-going dev. ADR-0012.
async function matchClientRecordId(
  ctx: ActionCtx,
  appToken: string,
  email: string | undefined,
): Promise<string | null> {
  const domain = email ? emailDomain(email) : null;
  if (!domain) return null;
  const data = await callFeishu<{ items?: { record_id: string }[] }>(ctx, {
    path: `/bitable/v1/apps/${appToken}/tables/${CLIENT_TABLE_ID}/records/search`,
    method: "POST",
    auth: "tenant",
    json: {
      filter: {
        conjunction: "and",
        conditions: [{ field_name: CLIENT_DOMAIN_FIELD, operator: "is", value: [domain] }],
      },
    },
    query: { page_size: "1" },
    label: "Bitable client domain search",
  });
  return data.items?.[0]?.record_id ?? null;
}

// Resolve the Client DuplexLink target for a sync: prefer the override picked
// in the Customer Picker (ADR-0013); fall back to the email-domain match
// against the Customer Table (ADR-0012). Both paths are read-only on the
// Customer Table; both may return null and that is OK (lenient by design).
async function resolveClientRecordId(
  ctx: ActionCtx,
  appToken: string,
  input: ServiceRowInput,
): Promise<string | null> {
  if (input.clientRecordId) return input.clientRecordId;
  return await matchClientRecordId(ctx, appToken, input.clientEmail);
}

// CREATE a new Service row. Never touches an existing row.
export const createServiceRecord = internalAction({
  args: serviceRowArgs,
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const { appToken, tableId } = requireBitableEnv();
    const clientRecordId = await resolveClientRecordId(ctx, appToken, args);
    const fields = buildServiceFields(args, clientRecordId);
    const data = await callFeishu<{ record?: { record_id: string } }>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      method: "POST",
      auth: "tenant",
      json: { fields },
      label: "Bitable create service row",
    });
    return { recordId: data.record?.record_id ?? "" };
  },
});

// CORRECTION update — bounded to a row THIS flow just created (ADR-0012). The
// caller MUST pass a recordId returned by createServiceRecord in the same session;
// never a pre-existing record_id.
export const correctServiceRecord = internalAction({
  args: { recordId: v.string(), ...serviceRowArgs },
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const { appToken, tableId } = requireBitableEnv();
    const clientRecordId = await resolveClientRecordId(ctx, appToken, args);
    const fields = buildServiceFields(args, clientRecordId);
    const data = await callFeishu<{ record?: { record_id: string } }>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${args.recordId}`,
      method: "PUT",
      auth: "tenant",
      json: { fields },
      label: "Bitable correct service row",
    });
    return { recordId: data.record?.record_id ?? args.recordId };
  },
});

// Read-only schema introspection. Official "List fields" API (GET, no body):
//   GET /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields
//   https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list
// Used to map the email -> the table's REAL columns before writing. Touches no rows.
export const listFields = internalAction({
  args: { tableId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    fields: { name: string; type: number; ui: string; primary: boolean; property: unknown }[];
  }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    const tableId = args.tableId ?? process.env.FEISHU_BITABLE_TABLE_ID;
    if (!appToken || !tableId) {
      throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
    }
    const data = await callFeishu<{
      items?: {
        field_name: string;
        type: number;
        ui_type?: string;
        is_primary?: boolean;
        property?: unknown;
      }[];
    }>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/fields`,
      method: "GET",
      auth: "tenant",
      query: { page_size: "100" },
      label: "Bitable list fields",
    });
    return {
      fields: (data.items ?? []).map((f) => ({
        name: f.field_name,
        type: f.type,
        ui: f.ui_type ?? "",
        primary: f.is_primary ?? false,
        property: f.property,
      })),
    };
  },
});
