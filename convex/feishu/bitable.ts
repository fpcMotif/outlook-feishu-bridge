/* eslint-disable max-lines */
import { internalAction, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu } from "./call";
import {
  buildServiceCreateFields,
  buildServiceFields,
  buildServiceSalesFields,
  type ServiceRowInput,
} from "./serviceRow";
import { emailDomain } from "./customers";
import { isDevFixtureRecordId } from "./devCustomerFixtures";
import {
  initiatorValidator,
  selectedCoworkerValidator,
} from "../emailRecord";

// Bitable record writes for the sales "Service" table. Endpoints + field-value
// formats come from the official Feishu docs (the ONLY source of truth):
//   create  POST /bitable/v1/apps/{app}/tables/{table}/records
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/create
//   update  PUT  /bitable/v1/apps/{app}/tables/{table}/records/{record_id}
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/update
//   search  POST /bitable/v1/apps/{app}/tables/{table}/records/search
//     https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/search
// Field-value SHAPES (and how this file maps the SPA intake to them) live in
// `serviceRow.ts` - the pure module that is unit-tested. This file only owns
// the env config, the Customer-Table lookup (read-only), and the HTTP path.
// HARD RULE (ADR-0010 / ADR-0012): never modify or delete a PRE-EXISTING row. We
// only CREATE new rows and may correction-UPDATE a row THIS flow just created; the
// customer table is only ever READ (searched).

// Customer table the main "Client" DuplexLink points at, and its email-domain
// Text field (found via list-fields). Domain matching is intentionally simple:
// the richer match rules are on-going development and slot into matchClientRecordId.
const CLIENT_TABLE_ID = "tbl4TE2GV472sKzp";
const CLIENT_DOMAIN_FIELD = "域名";

// Shared write args. The client is the email sender; if `clientRecordId` is
// passed (the salesperson's override picked from the Customer Picker, ADR-0013)
// we use it directly. Otherwise we fall back to the legacy email-domain match
// against the Customer Table. `subject` + `initiator` are written into the
// row's `Email Subject` and `Sales` columns respectively (ADR-0014). ADR-0022
// reverses ADR-0010's body-off-Base rule: the consolidated `requestNote` and the
// plain-text `body` now ride to the Base row (the Email Record keeps only a
// preview). Attachment file tokens are added with the staging slice.
const serviceRowArgs = {
  subject: v.optional(v.string()),
  clientEmail: v.optional(v.string()),
  clientRecordId: v.optional(v.string()),
  dateOfOffer: v.optional(v.number()),
  requestNote: v.optional(v.string()),
  body: v.optional(v.string()),
  attachments: v.optional(v.array(v.object({ fileToken: v.string() }))),
  selectedCoworkers: v.optional(v.array(selectedCoworkerValidator)),
  selectedSales: v.optional(initiatorValidator),
  initiator: v.optional(initiatorValidator),
  // ADR-0017: Outlook `item.conversationId` lands in the Service row's
  // `Email Conversation ID` column as the Bitable-to-Outlook join key.
  emailConversationId: v.optional(v.string()),
  // ADR-0012: Feishu create supports client_token for idempotent retries.
  // The request-sync outbox stores one token per email so scheduler retries
  // cannot create duplicate Base rows after a transient failure.
  clientToken: v.optional(v.string()),
};

function requireBitableEnv() {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
  if (!appToken || !tableId) {
    throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
  }
  return { appToken, tableId };
}

// READ-ONLY. Resolve a customer record_id by the email's domain field, or null.
// Lenient by design: no domain / no match -> null (Client left unlinked, the email
// stays on the Convex Email Record). Richer rules are on-going dev. ADR-0012.
export async function matchClientRecordId(
  ctx: ActionCtx,
  appToken: string,
  email: string | undefined,
): Promise<string | null> {
  const domain = email ? emailDomain(email) : null;
  if (!domain) return null;
  const data = await callFeishu<{ items?: { record_id: string; fields?: Record<string, unknown> }[] }>(ctx, {
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
  const first = data.items?.[0];
  // The Client DuplexLink links by the IMMUTABLE Feishu API record_id, never the
  // user-facing "Record Id" column (which only equals the API id while it stays a
  // RECORD_ID() formula — ADR-0021). Use record_id directly so the link is
  // robust to that column being changed to a manual field.
  return first?.record_id ?? null;
}

// Resolve the Client DuplexLink target for a sync: prefer the override picked
// in the Customer Picker (ADR-0013); fall back to the email-domain match
// against the Customer Table (ADR-0012). Both paths are read-only on the
// Customer Table; both may return null and that is OK (lenient by design).
export async function resolveClientRecordId(
  ctx: ActionCtx,
  appToken: string,
  input: ServiceRowInput,
): Promise<string | null> {
  if (input.clientRecordId) {
    // A dev-fixture pick is not a real Customer row — never link it, or Bitable
    // shows a dangling "?????" Client cell. Leave it unlinked (dev-only path).
    if (isDevFixtureRecordId(input.clientRecordId)) {
      console.warn(
        `[bitable] dropping dev-fixture clientRecordId=${input.clientRecordId}; leaving Client unlinked`,
      );
      return null;
    }
    return input.clientRecordId;
  }
  return await matchClientRecordId(ctx, appToken, input.clientEmail);
}

export function logServiceRecordIntake(
  args: ServiceRowInput,
  resolvedClientRecordId: string | null,
  fields: Record<string, unknown>,
): void {
  console.log(
    `[bitable] createServiceRecord clientLinked=${Boolean(resolvedClientRecordId)} ` +
      `note=${args.requestNote?.trim() ? "y" : "n"} bodyLen=${args.body?.length ?? 0} ` +
      `attachments=${args.attachments?.length ?? 0} coworkers=${args.selectedCoworkers?.length ?? 0} ` +
      `hasSales=${Boolean(args.selectedSales?.openId ?? args.initiator?.openId)} subjectLen=${args.subject?.length ?? 0} ` +
      `convIdLen=${args.emailConversationId?.length ?? 0} fieldKeys=[${Object.keys(fields).join(",")}]`,
  );
  if (process.env.BITABLE_DIAG_LOG === "1") {
    console.log(
      `[bitable] DIAG intake=${JSON.stringify({
        subject: args.subject,
        clientEmail: args.clientEmail,
        clientRecordId: args.clientRecordId,
        resolvedClientRecordId,
        dateOfOffer: args.dateOfOffer,
        emailConversationId: args.emailConversationId,
        selectedSales: args.selectedSales ?? args.initiator,
        coworkers: args.selectedCoworkers,
        requestNote: args.requestNote,
        bodyLen: args.body?.length ?? 0,
        attachmentCount: args.attachments?.length ?? 0,
      })} fields=${JSON.stringify(fields)}`,
    );
  }
}

// CREATE a new Service row. Never touches an existing row.
export const createServiceRecord = internalAction({
  args: serviceRowArgs,
  handler: async (ctx, args): Promise<{ recordId: string }> => {
    const { appToken, tableId } = requireBitableEnv();
    const clientRecordId = await resolveClientRecordId(ctx, appToken, args);
    const createFields = buildServiceCreateFields(args, clientRecordId);
    logServiceRecordIntake(args, clientRecordId, createFields);
    const data = await callFeishu<{ record?: { record_id: string } }>(ctx, {
      path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records`,
      method: "POST",
      auth: "tenant",
      json: { fields: createFields },
      query: args.clientToken ? { client_token: args.clientToken } : undefined,
      label: "Bitable create service row",
    });
    const recordId = data.record?.record_id ?? "";
    const salesFields = buildServiceSalesFields(args);
    if (recordId && Object.keys(salesFields).length > 0) {
      await callFeishu<{ record?: { record_id: string } }>(ctx, {
        path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${recordId}`,
        method: "PUT",
        auth: "tenant",
        json: { fields: salesFields },
        label: "Bitable patch Sales after Main Email",
      });
    }
    return { recordId };
  },
});

// CORRECTION update - bounded to a row THIS flow just created (ADR-0012). The
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

// Diagnostic: get one record by record_id (READ-ONLY), or search for one with
// Client set, so we can compare Feishu's stored DuplexLink cell shape against
// what we're sending on writes.
export const diagGetRecord = internalAction({
  args: { tableId: v.optional(v.string()), recordId: v.string() },
  handler: async (ctx, args): Promise<{ ok: boolean; record?: unknown; error?: string }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    const tableId = args.tableId ?? process.env.FEISHU_BITABLE_TABLE_ID;
    if (!appToken || !tableId) {
      return { ok: false, error: "env not set" };
    }
    try {
      const data = await callFeishu<{ record?: unknown }>(ctx, {
        path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/${args.recordId}`,
        method: "GET",
        auth: "tenant",
        label: "Bitable diag get record",
      });
      return { ok: true, record: data.record };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

export const diagSearchAnyClientRow = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; sample?: unknown; error?: string }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    const tableId = process.env.FEISHU_BITABLE_TABLE_ID;
    if (!appToken || !tableId) return { ok: false, error: "env not set" };
    try {
      const data = await callFeishu<{ items?: { record_id: string; fields?: Record<string, unknown> }[] }>(ctx, {
        path: `/bitable/v1/apps/${appToken}/tables/${tableId}/records/search`,
        method: "POST",
        auth: "tenant",
        json: {
          filter: {
            conjunction: "and",
            conditions: [{ field_name: "Client", operator: "isNotEmpty", value: [] }],
          },
        },
        query: { page_size: "1" },
        label: "Bitable diag search Client",
      });
      const first = data.items?.[0];
      return { ok: true, sample: { recordId: first?.record_id, clientCell: first?.fields?.["Client"] } };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// List a few raw records from the LIVE Customer Info table so we can compare
// real record_ids with what the mirror has cached.
export const diagListCustomers = internalAction({
  args: {},
  handler: async (ctx): Promise<{ ok: boolean; records?: { record_id: string; accountName?: unknown }[]; error?: string }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    if (!appToken) return { ok: false, error: "env not set" };
    try {
      const data = await callFeishu<{ items?: { record_id: string; fields?: Record<string, unknown> }[] }>(ctx, {
        path: `/bitable/v1/apps/${appToken}/tables/${CLIENT_TABLE_ID}/records`,
        method: "GET",
        auth: "tenant",
        query: { page_size: "5" },
        label: "Bitable diag list customers",
      });
      return {
        ok: true,
        records: (data.items ?? []).map((i) => ({
          record_id: i.record_id,
          accountName: i.fields?.["Account Name"],
        })),
      };
    } catch (e: unknown) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
});

// Read-only schema introspection. Official "List fields" API (GET, no body):
//   GET /open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields
//   https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-field/list
// Used to map the email -> the table's REAL columns before writing. Touches no rows.
export const listFields = internalAction({
  args: { tableId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<{
    fields: { id: string; name: string; type: number; ui: string; primary: boolean; property: unknown }[];
  }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    const tableId = args.tableId ?? process.env.FEISHU_BITABLE_TABLE_ID;
    if (!appToken || !tableId) {
      throw new Error("FEISHU_BITABLE_APP_TOKEN and FEISHU_BITABLE_TABLE_ID must be set");
    }
    const data = await callFeishu<{
      items?: {
        field_id?: string;
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
        id: f.field_id ?? "",
        name: f.field_name,
        type: f.type,
        ui: f.ui_type ?? "",
        primary: f.is_primary ?? false,
        property: f.property,
      })),
    };
  },
});
