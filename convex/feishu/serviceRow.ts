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
// MultiSelect -> string[]; Text -> string; DateTime -> epoch ms;
// User -> [{ id: open_id }]; DuplexLink -> [record_id].

// Request-card title -> "Request Type" MultiSelect option. The Bitable option is
// literally "Qutation" (misspelled) — it must match exactly or Feishu rejects it.
const REQUEST_TYPE_OPTION: Record<string, string> = {
  Quotation: "Qutation",
  Sample: "Sample",
  "R&D Support": "R&D Support",
};
// Request-card title -> its note Text column.
const NOTE_FIELD: Record<string, string> = {
  Quotation: "Quotation Note",
  Sample: "Sample Note",
  "R&D Support": "R&D Support Note",
};

export interface ServiceRowInput {
  subject?: string;
  clientEmail?: string;
  clientRecordId?: string;
  dateOfOffer?: number;
  requestSelections?: { requestType: string; note: string }[];
  selectedCoworkers?: { openId: string; name: string; avatarUrl?: string }[];
  initiator?: { openId: string; name?: string };
}

/**
 * Build the Service row's `fields` — "derivable only" (ADR-0010) plus the
 * additions ADR-0014 introduced (`Sales` Initiator + `Email Subject`).
 * Business Branch / Service Type are intentionally left blank (filled
 * manually in Bitable).
 */
export function buildServiceFields(
  input: ServiceRowInput,
  clientRecordId: string | null,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};

  const types = (input.requestSelections ?? [])
    .map((r) => REQUEST_TYPE_OPTION[r.requestType])
    .filter((t): t is string => t !== undefined);
  if (types.length > 0) fields["Request Type"] = types;
  for (const r of input.requestSelections ?? []) {
    const noteField = NOTE_FIELD[r.requestType];
    if (noteField && r.note.trim()) fields[noteField] = r.note;
  }

  if (!input.selectedCoworkers || input.selectedCoworkers.length !== 1) {
    throw new Error("Bitable Service row requires exactly one Feishu coworker");
  }
  fields["Co Worker"] = input.selectedCoworkers.map((c) => ({ id: c.openId }));

  if (input.dateOfOffer !== undefined) fields["Date of Offer"] = input.dateOfOffer;
  if (clientRecordId) fields["Client"] = [clientRecordId];

  // ADR-0014 additions:
  if (input.subject && input.subject.trim()) fields["Email Subject"] = input.subject;
  if (input.initiator?.openId) fields["Sales"] = [{ id: input.initiator.openId }];

  return fields;
}
