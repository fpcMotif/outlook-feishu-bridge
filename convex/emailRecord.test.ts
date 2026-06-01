import { describe, it, expect } from "vitest";
import {
  buildRequestSyncKey,
  toEmailRecord,
  type EmailRecord,
  type EmailRecordInput,
} from "./emailRecord";

const syncInput: EmailRecordInput = {
  subject: "Q3 numbers",
  from: "alice@corp.com",
  clientEmail: "client@corp.com",
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
  clientEmail: "client@corp.com",
  to: ["bob@corp.com", "carol@corp.com"],
  cc: ["dave@corp.com"],
  bodyPreview: "Here are the figures.",
  internetMessageId: "<msg-1@corp.com>",
  itemId: "AAItem1",
  conversationId: "conv-1",
  userEmail: "me@corp.com",
  requestSyncKey: "me@corp.com\nconv-1",
  dateTimeCreated: 1716000000000,
  sentToBot: false,
  sentToChat: false,
  sentToBitable: true,
  sentToContacts: undefined,
  sentToGroups: undefined,
  requestSelections: [{ requestType: "Quotation", note: "Need a quarterly quote." }],
  selectedCoworkers: [{ openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" }],
  selectedCustomer: undefined,
  initiator: undefined,
  feishuMessageId: undefined,
  bitableRecordId: "rec_1",
  pdfFileKey: undefined,
  attachmentFileKeys: undefined,
  feishuDocUrl: undefined,
  feishuDocToken: undefined,
  bitableClientToken: undefined,
  bitableSyncStatus: undefined,
  bitableLastError: undefined,
  bitableLastAttemptAt: undefined,
  bitableAttemptCount: undefined,
  bitableNextRetryAt: undefined,
};

describe("toEmailRecord", () => {
  it("derives the idempotency key from user mailbox plus Outlook conversation id", () => {
    expect(buildRequestSyncKey(" Me@Corp.COM ", " conv-1 ")).toBe("me@corp.com\nconv-1");
    expect(buildRequestSyncKey("", "conv-1")).toBeNull();
    expect(buildRequestSyncKey("me@corp.com", "")).toBeNull();
  });

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

  it("can create a pending Convex backup before the Bitable row exists", () => {
    const record = toEmailRecord(syncInput, { sentToBitable: false });
    expect(record.sentToBitable).toBe(false);
    expect(record.bitableRecordId).toBeUndefined();
    expect(record.clientEmail).toBe("client@corp.com");
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
