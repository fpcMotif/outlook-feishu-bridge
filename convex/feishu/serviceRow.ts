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
  /** Sales rep on the row (picker override; defaults to signed-in user in the SPA). */
  selectedSales?: { openId: string; name?: string };
  /** @deprecated Use selectedSales — kept for reconcile rows stored before the picker. */
  initiator?: { openId: string; name?: string };
  // Outlook `item.conversationId` — the salesperson-mailbox-local thread id for
  // the original client email. Lands in the Service row's `Email Conversation ID`
  // Text column as the join key Bitable→Outlook (ADR-0017). Distinct from the
  // Self-Forward copy's conversationId, which is not written.
  emailConversationId?: string;
}

// Returns the set of Bitable column names listed in DIAG_SKIP_FIELDS (comma-
// separated). Used to binary-search which field is tripping the live
// 1255001 InternalError on the Bitable create — flip the env var without
// redeploying since Convex actions read env at call time.
function readSkipSet(): Set<string> {
  return new Set(
    (process.env.DIAG_SKIP_FIELDS ?? "")
      .split(",")
      .flatMap((s) => {
        const field = s.trim();
        return field ? [field] : [];
      }),
  );
}

// Set an optional plain-Text column only when it has non-whitespace content and
// the diagnostic skip switch isn't suppressing it. Shared by every Text column so
// buildServiceFields stays a flat list of column writes.
function setText(
  fields: Record<string, unknown>,
  skip: Set<string>,
  column: string,
  value: string | undefined,
): void {
  if (value && value.trim() && !skip.has(column)) fields[column] = value;
}

/** Sets the `Data From` SingleSelect to the email-intake option (not clientEmail). */
function setDataFromEmailSource(fields: Record<string, unknown>, skip: Set<string>): void {
  if (!skip.has(DATA_FROM_COLUMN)) fields[DATA_FROM_COLUMN] = DATA_FROM_EMAIL_OPTION;
}

function resolveSelectedSales(
  input: ServiceRowInput,
): { openId: string; name?: string } | undefined {
  return input.selectedSales ?? input.initiator;
}

function shouldPatchSalesAfterCreate(input: ServiceRowInput): boolean {
  return Boolean(resolveSelectedSales(input)?.openId);
}

/**
 * Phase-1 create fields: everything except `Sales` (including `Data From` =
 * `Email `). Sales is patched in a follow-up PUT (bitable.ts) so Feishu Base
 * automations can settle on the row before the User column is set.
 */
export function buildServiceCreateFields(
  input: ServiceRowInput,
  clientRecordId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const skip = readSkipSet();
  if (skip.size > 0) console.log(`[bitable] DIAG_SKIP_FIELDS active: ${[...skip].join("|")}`);

  setDataFromEmailSource(fields, skip);
  setText(fields, skip, REQUEST_NOTE_COLUMN, input.requestNote);
  setText(fields, skip, EMAIL_BODY_COLUMN, input.body);
  setText(fields, skip, "Email Subject", input.subject);
  setText(fields, skip, "Email Conversation ID", input.emailConversationId);

  if (input.attachments && input.attachments.length > 0 && !skip.has(ATTACHMENTS_COLUMN)) {
    fields[ATTACHMENTS_COLUMN] = input.attachments.map((a) => ({ file_token: a.fileToken }));
  }

  if (!input.selectedCoworkers || input.selectedCoworkers.length !== 1) {
    throw new Error("Bitable Service row requires exactly one Feishu coworker");
  }
  if (!skip.has("Co Worker")) {
    fields["Co Worker"] = input.selectedCoworkers.map((c) => ({ id: c.openId }));
  }

  if (input.dateOfOffer !== undefined && !skip.has("Date of Offer")) fields["Date of Offer"] = input.dateOfOffer;

  if (clientRecordId) fields["Client"] = [clientRecordId];

  return fields;
}

/**
 * Phase-3 patch: the `Sales Files` Attachment column only (ADR-0027). Deferred
 * **Attachment Fill** PUTs the cumulative `file_token`s onto the just-created row
 * after the create — modeled on the phase-2 Sales patch. An empty list writes
 * nothing (never clears the cell). The DIAG skip switch suppresses it like the
 * create path.
 */
export function buildServiceAttachmentFields(
  attachments: { fileToken: string }[],
): Record<string, unknown> {
  if (attachments.length === 0) return {};
  const skip = readSkipSet();
  if (skip.has(ATTACHMENTS_COLUMN)) return {};
  return { [ATTACHMENTS_COLUMN]: attachments.map((a) => ({ file_token: a.fileToken })) };
}

/** Phase-2 patch: `Sales` User column only (after `Data From` on create). */
export function buildServiceSalesFields(input: ServiceRowInput): Record<string, unknown> {
  if (!shouldPatchSalesAfterCreate(input)) return {};

  const skip = readSkipSet();
  const sales = resolveSelectedSales(input);
  if (!sales?.openId || skip.has("Sales")) return {};

  return { Sales: [{ id: sales.openId }] };
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
