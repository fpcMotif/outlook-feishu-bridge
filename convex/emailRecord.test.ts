import { describe, it, expect } from "vitest";
import { toEmailRecord, type EmailRecord, type EmailRecordInput } from "./emailRecord";

const syncInput: EmailRecordInput = {
  subject: "Q3 numbers",
  from: "alice@corp.com",
  to: ["bob@corp.com", "carol@corp.com"],
  cc: ["dave@corp.com"],
  body: "Here are the figures.",
  internetMessageId: "<msg-1@corp.com>",
  itemId: "AAItem1",
  conversationId: "conv-1",
  userEmail: "me@corp.com",
  dateTimeCreated: 1716000000000,
  requestSelections: [{ requestType: "Quotation", note: "Need a quarterly quote." }],
  selectedCoworkers: [{ openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" }],
};

const syncRecord: EmailRecord = {
  subject: "Q3 numbers",
  from: "alice@corp.com",
  to: ["bob@corp.com", "carol@corp.com"],
  cc: ["dave@corp.com"],
  bodyPreview: "Here are the figures.",
  internetMessageId: "<msg-1@corp.com>",
  itemId: "AAItem1",
  conversationId: "conv-1",
  userEmail: "me@corp.com",
  dateTimeCreated: 1716000000000,
  sentToBot: false,
  sentToChat: false,
  sentToBitable: true,
  sentToContacts: undefined,
  sentToGroups: undefined,
  requestSelections: [{ requestType: "Quotation", note: "Need a quarterly quote." }],
  selectedCoworkers: [{ openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" }],
  feishuMessageId: undefined,
  bitableRecordId: "rec_1",
  pdfFileKey: undefined,
  attachmentFileKeys: undefined,
  feishuDocUrl: undefined,
  feishuDocToken: undefined,
};

describe("toEmailRecord", () => {
  it("maps a Bitable Sync onto the persisted Email Record", () => {
    expect(toEmailRecord(syncInput, { bitableRecordId: "rec_1" })).toEqual(syncRecord);
  });

  it("carries the request selections and single chosen Coworker through unchanged", () => {
    const record = toEmailRecord(syncInput, {});
    expect(record.requestSelections).toEqual([
      { requestType: "Quotation", note: "Need a quarterly quote." },
    ]);
    expect(record.selectedCoworkers).toEqual([
      { openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" },
    ]);
  });

  it("truncates the body to a 500-char preview; the full body is never persisted", () => {
    const record = toEmailRecord({ ...syncInput, body: "x".repeat(600) }, {});
    expect(record.bodyPreview).toHaveLength(500);
    expect(record.bodyPreview).toBe("x".repeat(500));
  });

  it("sets retired delivery fields false or undefined for schema compatibility", () => {
    const record = toEmailRecord(
      {
        subject: "s",
        from: "f",
        to: [],
        cc: [],
        body: "b",
        internetMessageId: "id",
      },
      {},
    );
    expect(record.bodyPreview).toBe("b");
    expect(record.sentToBot).toBe(false);
    expect(record.sentToChat).toBe(false);
    expect(record.sentToBitable).toBe(true);
    expect(record.sentToContacts).toBeUndefined();
    expect(record.sentToGroups).toBeUndefined();
    expect(record.requestSelections).toBeUndefined();
    expect(record.selectedCoworkers).toBeUndefined();
    expect(record.attachmentFileKeys).toBeUndefined();
    expect(record.pdfFileKey).toBeUndefined();
    expect(record.feishuMessageId).toBeUndefined();
    expect(record.feishuDocUrl).toBeUndefined();
  });
});
