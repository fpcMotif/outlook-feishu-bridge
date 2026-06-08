// Pure builder for the Feishu Bitable Service-row `fields` payload. Translates
// the SPA's intake into the exact field shapes the Bitable v1 record API
// expects. No I/O — testable in isolation, so every column write is pinned by
// a unit test in serviceRow.test.ts.
//
// Field-value formats are taken from the official Feishu docs (the ONLY source
// of truth, per the standing rule):
//   record data structure overview:
//     https://open.feishu.cn/document/docs/bitable-v1/app-table-record/bitable-record-data-structure-overview
//   SDK reference: https://github.com/larksuite/oapi-sdk-go
// Text -> string; DateTime -> epoch ms; User -> [{ id: open_id }];
// DuplexLink -> [record_id].
//
// FORBIDDEN: the "Request Type" MultiSelect is NOT written from the add-in. It
// is owned inside Feishu (set manually / by a Base automation). Writing it here
// duplicated the Feishu-managed value (live cells showed extra "+N" chips), so
// the mapping was removed. Do not re-add a Request Type write.

// Bitable column name for the consolidated salesperson note. ADR-0022 collapsed
// the three per-category Note columns (Quotation/Sample/R&D Support) into one;
// the live Base reuses the existing `Quotation Note` Text column for it.
// CONFIRMED against the live schema via listFields (2026-06-03). MUST match the
// live Base column exactly — the add-in cannot create columns, so a rename
// without a matching Base column silently drops the write / fails the create
// with 1254045 FieldNameNotFound (which is exactly what the assumed names did).
const REQUEST_NOTE_COLUMN = "Quotation Note";

// Bitable column for the plain-text mail body (ADR-0022). Live column is
// `Email Content` (Text, type 1). CONFIRMED via listFields (2026-06-03).
const EMAIL_BODY_COLUMN = "Email Content";

// Bitable Attachment column (Feishu field type 17) carrying the staged Feishu
// Drive `file_token`s (ADR-0022). Live column is `Sales Files` (Attachment,
// type 17). CONFIRMED via listFields (2026-06-03).
const ATTACHMENTS_COLUMN = "Sales Files";

// Intake source on the Service row — SingleSelect (type 3), NOT Text. CONFIRMED
// via listFields (2026-06-03): fld0yFgPbj, options `Email ` (trailing space) and
// `Form`. Outlook add-in writes the `Email ` option on create (source = email
// intake), never the real clientEmail — that address is used only for Client
// DuplexLink resolution (domain match via bitable.ts) or the user-selected link.
const DATA_FROM_COLUMN = "Data From";
const DATA_FROM_EMAIL_OPTION = "Email ";

export interface ServiceRowInput {
  subject?: string;
  clientEmail?: string;
  clientRecordId?: string;
  dateOfOffer?: number;
  // The salesperson's single consolidated note (ADR-0022). Replaces the retired
  // per-category requestSelections[]; written to the `Quotation Note` column.
  requestNote?: string;
  // The Mail Item's plain-text body via Office.js CoercionType.Text (excludes
  // attachments/inline images). Written in full to `Email Content` — no cap, since
  // inbound is a single received message (ADR-0022).
  body?: string;
  // Feishu Drive `file_token`s for the selected mail attachments + uploaded files
  // (already staged via Convex storage and uploaded to Drive). Written to the
  // single `Attachments` column as [{ file_token }] (ADR-0022).
  attachments?: { fileToken: string }[];
  selectedCoworkers?: { openId: string; name: string; avatarUrl?: string }[];
  // The salesperson attributed on the row, written to the `Sales` (User) column —
  // already resolved by the caller (picker override, else the signed-in clicker).
  // Distinct from the Email Record's `initiator` audit, which the caller keeps;
  // the Base row only needs the one Sales identity (CONTEXT: Sales vs Initiator).
  sales?: { openId: string; name?: string };
  // Outlook `item.conversationId` — the salesperson-mailbox-local thread id for
  // the original client email. Lands in the Service row's `Email Conversation ID`
  // Text column as the join key Bitable→Outlook (ADR-0017). Distinct from the
  // Self-Forward copy's conversationId, which is not written.
  emailConversationId?: string;
}

// Set an optional plain-Text column only when it has non-whitespace content, so
// buildServiceCreateFields stays a flat list of column writes.
function setText(
  fields: Record<string, unknown>,
  column: string,
  value: string | undefined,
): void {
  if (value && value.trim()) fields[column] = value;
}

/**
 * Phase-1 create fields: everything except `Sales` (including `Data From` =
 * `Email `). Sales is patched in a follow-up PUT (bitable.ts) so Feishu Base
 * automations can settle on the row before the User column is set.
 *
 * A flat list of column writes — the per-field `DIAG_SKIP_FIELDS` env knob (a
 * one-off binary search for a column-tripping create error) was removed once the
 * live column names were CONFIRMED stable (see constants above, listFields
 * 2026-06-03). To inspect a live row's stored cells, use the read-only
 * `bitable.diagGetRecord` / `diagSearchAnyClientRow` actions instead.
 */
export function buildServiceCreateFields(
  input: ServiceRowInput,
  clientRecordId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = { [DATA_FROM_COLUMN]: DATA_FROM_EMAIL_OPTION };
  setText(fields, REQUEST_NOTE_COLUMN, input.requestNote);
  setText(fields, EMAIL_BODY_COLUMN, input.body);
  setText(fields, "Email Subject", input.subject);
  setText(fields, "Email Conversation ID", input.emailConversationId);

  if (input.attachments && input.attachments.length > 0) {
    fields[ATTACHMENTS_COLUMN] = input.attachments.map((a) => ({ file_token: a.fileToken }));
  }

  if (!input.selectedCoworkers || input.selectedCoworkers.length !== 1) {
    throw new Error("Bitable Service row requires exactly one Feishu coworker");
  }
  fields["Co Worker"] = input.selectedCoworkers.map((c) => ({ id: c.openId }));

  if (input.dateOfOffer !== undefined) fields["Date of Offer"] = input.dateOfOffer;

  if (clientRecordId) fields["Client"] = [clientRecordId];

  return fields;
}

/** Phase-2 patch: `Sales` User column only (after `Data From` on create). */
export function buildServiceSalesFields(input: ServiceRowInput): Record<string, unknown> {
  return input.sales?.openId ? { Sales: [{ id: input.sales.openId }] } : {};
}

/**
 * Full correction payload (create fields + Sales). Used by bounded PUT updates.
 */
export function buildServiceFields(
  input: ServiceRowInput,
  clientRecordId: string | null,
): Record<string, unknown> {
  return {
    ...buildServiceCreateFields(input, clientRecordId),
    ...buildServiceSalesFields(input),
  };
}
