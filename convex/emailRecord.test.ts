import { describe, it, expect } from "vitest";
import { toEmailRecord, type EmailRecord, type ForwardRecordInput } from "./emailRecord";

const fullInput: ForwardRecordInput = {
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
  targets: { bot: true, chat: true, bitable: false },
  contacts: ["ou_abc"],
  groups: ["oc_xyz"],
  requestSelections: [{ requestType: "quotation", note: "Need a quarterly quote." }],
  selectedCoworkers: [{ openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" }],
  attachmentFileKeys: [{ fileKey: "file_k1", fileName: "a.pdf", type: "file" }],
  feishuDocUrl: "https://feishu.cn/docx/doc1",
  feishuDocToken: "doc1",
};

const fullRecord: EmailRecord = {
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
  sentToBot: true,
  sentToChat: true,
  sentToBitable: false,
  sentToContacts: ["ou_abc"],
  sentToGroups: ["oc_xyz"],
  requestSelections: [{ requestType: "quotation", note: "Need a quarterly quote." }],
  selectedCoworkers: [{ openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" }],
  feishuMessageId: "om_1",
  bitableRecordId: "rec_1",
  pdfFileKey: "pdf_k1",
  attachmentFileKeys: [{ fileKey: "file_k1", fileName: "a.pdf", type: "file" }],
  feishuDocUrl: "https://feishu.cn/docx/doc1",
  feishuDocToken: "doc1",
};

describe("toEmailRecord", () => {
  it("maps a full forward onto the persisted record", () => {
    expect(
      toEmailRecord(fullInput, { feishuMessageId: "om_1", bitableRecordId: "rec_1" }, "pdf_k1"),
    ).toEqual(fullRecord);
  });

  it("carries the request selections and chosen coworkers through unchanged", () => {
    const record = toEmailRecord(fullInput, {});
    expect(record.requestSelections).toEqual([
      { requestType: "quotation", note: "Need a quarterly quote." },
    ]);
    expect(record.selectedCoworkers).toEqual([
      { openId: "ou_abc", name: "Bob", avatarUrl: "https://cdn/bob.png" },
    ]);
  });

  it("truncates the body to a 500-char preview; the full body is never persisted", () => {
    const record = toEmailRecord({ ...fullInput, body: "x".repeat(600) }, {});
    expect(record.bodyPreview).toHaveLength(500);
    expect(record.bodyPreview).toBe("x".repeat(500));
  });

  it("leaves absent optionals undefined and flattens targets", () => {
    const record = toEmailRecord(
      {
        subject: "s",
        from: "f",
        to: [],
        cc: [],
        body: "b",
        internetMessageId: "id",
        targets: { bot: false, chat: true, bitable: false },
      },
      {},
    );
    expect(record.bodyPreview).toBe("b");
    expect(record.sentToBot).toBe(false);
    expect(record.sentToChat).toBe(true);
    expect(record.itemId).toBeUndefined();
    expect(record.sentToContacts).toBeUndefined();
    expect(record.requestSelections).toBeUndefined();
    expect(record.selectedCoworkers).toBeUndefined();
    expect(record.attachmentFileKeys).toBeUndefined();
    expect(record.pdfFileKey).toBeUndefined();
    expect(record.feishuMessageId).toBeUndefined();
  });
});
