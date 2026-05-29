// Coverage top-up for emailRecord.ts. emailRecord.test.ts already covers the
// populated map, request/coworker pass-through, the >500-char truncation, and the
// minimal/retired-flags path. These two cases pin the boundary (a body of exactly
// 500 chars is NOT truncated) and the conversationId/userEmail/dateTimeCreated
// pass-through in isolation.

import { describe, expect, it } from "vitest";

import { toEmailRecord, type EmailRecordInput } from "./emailRecord";

const base: EmailRecordInput = {
  subject: "s",
  from: "f@corp.com",
  to: [],
  cc: [],
  body: "",
  internetMessageId: "<id@corp.com>",
};

describe("toEmailRecord boundaries", () => {
  it("preserves a body of exactly 500 chars at length 500 (not truncated)", () => {
    const body = "y".repeat(500);
    const record = toEmailRecord({ ...base, body }, {});
    expect(record.bodyPreview).toHaveLength(500);
    expect(record.bodyPreview).toBe(body);
  });

  it("preserves a 499-char body intact (below the cap)", () => {
    const body = "z".repeat(499);
    const record = toEmailRecord({ ...base, body }, {});
    expect(record.bodyPreview).toBe(body);
  });

  it("passes conversationId, userEmail and dateTimeCreated through unchanged", () => {
    const record = toEmailRecord(
      {
        ...base,
        conversationId: "conv-99",
        userEmail: "me@corp.com",
        dateTimeCreated: 1716000000123,
      },
      {},
    );
    expect(record.conversationId).toBe("conv-99");
    expect(record.userEmail).toBe("me@corp.com");
    expect(record.dateTimeCreated).toBe(1716000000123);
  });

  it("leaves optional pass-through fields undefined when the input omits them", () => {
    const record = toEmailRecord(base, {});
    expect(record.conversationId).toBeUndefined();
    expect(record.userEmail).toBeUndefined();
    expect(record.dateTimeCreated).toBeUndefined();
    expect(record.itemId).toBeUndefined();
  });

  it("carries bitableRecordId from the result ids onto the record", () => {
    const record = toEmailRecord(base, { bitableRecordId: "rec_42" });
    expect(record.bitableRecordId).toBe("rec_42");
  });
});
