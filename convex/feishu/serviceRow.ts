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
// the three per-category Note columns (Quotation/Sample/R&D Support) into one.
// MUST match the live Base column exactly — the add-in cannot create columns, so
// a rename without a matching Base column silently drops the write. Confirm
// against the live Base before deploy.
const REQUEST_NOTE_COLUMN = "Request Note";

// Bitable column for the plain-text mail body (ADR-0022). Same naming caveat as
// REQUEST_NOTE_COLUMN — must match the live Base column exactly.
const EMAIL_BODY_COLUMN = "Email Body";

// Bitable Attachment column (Feishu field type 17) carrying the staged Feishu
// Drive `file_token`s (ADR-0022). Same naming caveat — must match the live Base.
const ATTACHMENTS_COLUMN = "Attachments";

export interface ServiceRowInput {
  subject?: string;
  clientEmail?: string;
  clientRecordId?: string;
  dateOfOffer?: number;
  // The salesperson's single consolidated note (ADR-0022). Replaces the retired
  // per-category requestSelections[]; written to the `Request Note` column.
  requestNote?: string;
  // The Mail Item's plain-text body via Office.js CoercionType.Text (excludes
  // attachments/inline images). Written in full to `Email Body` — no cap, since
  // inbound is a single received message (ADR-0022).
  body?: string;
  // Feishu Drive `file_token`s for the selected mail attachments + uploaded files
  // (already staged via Convex storage and uploaded to Drive). Written to the
  // single `Attachments` column as [{ file_token }] (ADR-0022).
  attachments?: { fileToken: string }[];
  selectedCoworkers?: { openId: string; name: string; avatarUrl?: string }[];
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

/**
 * Build the Service row's `fields` — "derivable only" (ADR-0010) plus the
 * additions ADR-0014 introduced (`Sales` Initiator + `Email Subject`).
 * Business Branch / Service Type are intentionally left blank (filled
 * manually in Bitable). The `Request Type` MultiSelect is likewise NOT written
 * — Feishu owns that column (see the FORBIDDEN note at the top of the file).
 */
export function buildServiceFields(
  input: ServiceRowInput,
  clientRecordId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const skip = readSkipSet();
  if (skip.size > 0) console.log(`[bitable] DIAG_SKIP_FIELDS active: ${[...skip].join("|")}`);

  // Plain-Text columns. Request Type stays FORBIDDEN (Feishu owns it) — only the
  // salesperson's note crosses. `Request Note` + `Email Body` are ADR-0022 (body
  // is full / no cap); `Email Subject` is ADR-0014; `Email Conversation ID` is the
  // ADR-0017 Bitable→Outlook join key.
  setText(fields, skip, REQUEST_NOTE_COLUMN, input.requestNote);
  setText(fields, skip, EMAIL_BODY_COLUMN, input.body);
  setText(fields, skip, "Email Subject", input.subject);
  setText(fields, skip, "Email Conversation ID", input.emailConversationId);

  // ADR-0022: staged Drive file tokens -> the single Attachment cell. On WRITE
  // only file_token is load-bearing (name/type/size/url are read-only).
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

  // The Client DuplexLink is the business-critical customer link. It must not
  // be disabled by the temporary diagnostic skip switch.
  if (clientRecordId) fields["Client"] = [clientRecordId];

  // ADR-0014: the Initiator lands in the `Sales` User column.
  if (input.initiator?.openId && !skip.has("Sales")) fields["Sales"] = [{ id: input.initiator.openId }];

  return fields;
}
