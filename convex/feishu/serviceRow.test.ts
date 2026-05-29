// Pure unit tests for the Service-row field builder. The builder is the only
// place that translates the SPA's intake into the Feishu Bitable record `fields`
// shape — every column the Service row writes goes through here, so a pure
// test pins the shape against the official field formats cited in
// ADR-0012 / ADR-0014.

import { describe, expect, it } from "vitest";

import { buildServiceFields, type ServiceRowInput } from "./serviceRow";

const BASE: ServiceRowInput = {
  subject: "Inquiry: bulk L-Carnitine",
  selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny Xu" }],
};

describe("buildServiceFields", () => {
  // ADR-0014: the email Subject is mirrored to the Service row's
  // `Email Subject` Text column (one of the two columns ADR-0014 added).
  it("writes the email subject to the `Email Subject` Text column", () => {
    const fields = buildServiceFields(BASE, null);
    expect(fields["Email Subject"]).toBe("Inquiry: bulk L-Carnitine");
  });

  // ADR-0014: the Initiator (signed-in salesperson) lands in the `Sales` User
  // column in Feishu's official user-field shape `[{ id: open_id }]` — verified
  // against larksuite/oapi-sdk-go in ADR-0012 / ADR-0014.
  it("writes the Initiator open_id to the `Sales` User column when present", () => {
    const fields = buildServiceFields(
      { ...BASE, initiator: { openId: "ou_initiator", name: "Florian Meurer" } },
      null,
    );
    expect(fields["Sales"]).toEqual([{ id: "ou_initiator" }]);
  });

  // Initiator is optional — when not provided (e.g. dev-preview path with no
  // real Feishu login), the Sales column is simply not set; the row still
  // creates successfully.
  it("omits the `Sales` column entirely when no Initiator is provided", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Sales" in fields).toBe(false);
  });

  it("always writes the Client DuplexLink when a customer record id is resolved", () => {
    const originalSkip = process.env.DIAG_SKIP_FIELDS;
    process.env.DIAG_SKIP_FIELDS = "Client";
    const fields = buildServiceFields(BASE, "rec_customer");
    expect(fields["Client"]).toEqual(["rec_customer"]);
    if (originalSkip === undefined) delete process.env.DIAG_SKIP_FIELDS;
    else process.env.DIAG_SKIP_FIELDS = originalSkip;
  });
});

// ADR-0017: the Mail Item's Outlook conversationId rides into the
// `Email Conversation ID` Text column as the join key from the Bitable row
// back to the salesperson's mailbox view of the original client thread.
describe("buildServiceFields — Email Conversation ID column", () => {
  it("writes the Mail Item conversationId to the `Email Conversation ID` Text column", () => {
    const fields = buildServiceFields(
      { ...BASE, emailConversationId: "AAQkAGI0…convId…" },
      null,
    );
    expect(fields["Email Conversation ID"]).toBe("AAQkAGI0…convId…");
  });

  // The column is optional on the wire — the SPA may not have Office.js handy
  // (dev-preview / browser) or the Mail Item may have no conversationId.
  it("omits `Email Conversation ID` when no conversationId is provided", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Email Conversation ID" in fields).toBe(false);
  });

  // Whitespace-only conversationId is treated as absent — defensive against
  // upstream returning "" or " " from the Office.js callback.
  it("omits `Email Conversation ID` when conversationId is empty or whitespace", () => {
    const blank = buildServiceFields({ ...BASE, emailConversationId: "" }, null);
    const spaces = buildServiceFields({ ...BASE, emailConversationId: "   " }, null);
    expect("Email Conversation ID" in blank).toBe(false);
    expect("Email Conversation ID" in spaces).toBe(false);
  });
});
