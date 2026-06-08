// Pure unit tests for the Service-row field builder. The builder is the only
// place that translates the SPA's intake into the Feishu Bitable record `fields`
// shape — every column the Service row writes goes through here, so a pure
// test pins the shape against the official field formats cited in
// ADR-0012 / ADR-0014.

import { describe, expect, it } from "vitest";

import {
  buildServiceAttachmentFields,
  buildServiceCreateFields,
  buildServiceFields,
  buildServiceSalesFields,
  type ServiceRowInput,
} from "./serviceRow";

const BASE: ServiceRowInput = {
  subject: "Inquiry: bulk L-Carnitine",
  selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny Xu" }],
};

describe("buildServiceAttachmentFields", () => {
  it("writes only the Sales Files cell as [{ file_token }] in order", () => {
    expect(
      buildServiceAttachmentFields([{ fileToken: "boxA" }, { fileToken: "boxB" }]),
    ).toEqual({ "Sales Files": [{ file_token: "boxA" }, { file_token: "boxB" }] });
  });

  it("writes nothing for an empty token list (never clears the cell)", () => {
    expect(buildServiceAttachmentFields([])).toEqual({});
  });
});

describe("buildServiceFields", () => {
  // ADR-0014: the email Subject is mirrored to the Service row's
  // `Email Subject` Text column (one of the two columns ADR-0014 added).
  it("writes the email subject to the `Email Subject` Text column", () => {
    const fields = buildServiceFields(BASE, null);
    expect(fields["Email Subject"]).toBe("Inquiry: bulk L-Carnitine");
  });

  it("create fields write Data From and omit Sales (Sales patched in phase 2)", () => {
    const fields = buildServiceCreateFields(
      { ...BASE, clientEmail: "buyer@acme.com", selectedSales: { openId: "ou_rep", name: "Rep" } },
      null,
    );
    expect(fields["Data From"]).toBe("Email ");
    expect(fields["Data From"]).not.toBe("buyer@acme.com");
    expect("Sales" in fields).toBe(false);
  });
});

describe("buildServiceSalesFields", () => {
  it("writes Sales when a salesperson is selected", () => {
    const fields = buildServiceSalesFields({
      ...BASE,
      clientEmail: "buyer@acme.com",
      selectedSales: { openId: "ou_rep", name: "Rep" },
    });
    expect(fields.Sales).toEqual([{ id: "ou_rep" }]);
  });

  it("omits Sales when no salesperson is selected", () => {
    expect(buildServiceSalesFields(BASE)).toEqual({});
  });

  it("omits Sales when no salesperson is selected even with clientEmail", () => {
    expect(
      buildServiceSalesFields({
        ...BASE,
        clientEmail: "buyer@acme.com",
      }),
    ).toEqual({});
  });

  it("accepts legacy initiator as selectedSales", () => {
    const fields = buildServiceSalesFields({
      ...BASE,
      clientEmail: "buyer@acme.com",
      initiator: { openId: "ou_legacy", name: "Legacy" },
    });
    expect(fields.Sales).toEqual([{ id: "ou_legacy" }]);
  });
});

describe("buildServiceFields — merged correction payload", () => {
  it("includes Sales in the full correction payload when Data From is present", () => {
    const fields = buildServiceFields(
      {
        ...BASE,
        clientEmail: "buyer@acme.com",
        selectedSales: { openId: "ou_rep", name: "Rep" },
      },
      null,
    );
    expect(fields["Data From"]).toBe("Email ");
    expect(fields.Sales).toEqual([{ id: "ou_rep" }]);
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

// The "Request Type" MultiSelect is FORBIDDEN for the add-in to write — Feishu
// owns that column (set manually / by a Base automation). Writing it from here
// duplicated the Feishu-managed value (live cells showed extra "+N" chips), so
// the mapping was removed. These tests lock that in: no matter what selections
// arrive, the builder must never emit a `Request Type` key.
describe("buildServiceFields — Request Type is never written (Feishu owns it)", () => {
  it("omits Request Type even when the note is filled", () => {
    const fields = buildServiceFields(
      { ...BASE, requestNote: "FOB pls; 50g sample; spec sheet" },
      null,
    );
    expect("Request Type" in fields).toBe(false);
  });

  // ADR-0022: the three per-category Note columns collapse to ONE consolidated
  // `Quotation Note` Text column. The category concept is gone — a single note box.
  it("writes the consolidated note to the single `Quotation Note` Text column", () => {
    const fields = buildServiceFields(
      { ...BASE, requestNote: "FOB Shanghai, 500kg, samples first" },
      null,
    );
    expect(fields["Quotation Note"]).toBe("FOB Shanghai, 500kg, samples first");
    expect("Request Type" in fields).toBe(false);
  });

  it("omits Request Type when there are no selections", () => {
    const fields = buildServiceFields(BASE, null);
    expect("Request Type" in fields).toBe(false);
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

// ADR-0022: the consolidated note is optional — an empty / whitespace / missing
// note must not write the `Quotation Note` column (mirrors the other optional Text
// columns; defensive against the SPA sending "" or "   ").
describe("buildServiceFields — Quotation Note is optional", () => {
  it("omits `Quotation Note` when the note is empty, whitespace, or missing", () => {
    const blank = buildServiceFields({ ...BASE, requestNote: "" }, null);
    const spaces = buildServiceFields({ ...BASE, requestNote: "   " }, null);
    const missing = buildServiceFields(BASE, null);
    expect("Quotation Note" in blank).toBe(false);
    expect("Quotation Note" in spaces).toBe(false);
    expect("Quotation Note" in missing).toBe(false);
  });
});

// ADR-0022: the plain-text mail body (Office.js CoercionType.Text — excludes
// attachments/inline images) lands in a new `Email Content` Text column. Full body,
// no cap (inbound is a single received message; compose/reply items are rejected).
describe("buildServiceFields — Email Content column", () => {
  it("writes the plain-text body to the `Email Content` Text column", () => {
    const body = "Hi,\n\nPlease quote 500kg L-Carnitine FOB Shanghai.\n\nThanks";
    const fields = buildServiceFields({ ...BASE, body }, null);
    expect(fields["Email Content"]).toBe(body);
  });

  it("omits `Email Content` when the body is empty, whitespace, or missing", () => {
    const blank = buildServiceFields({ ...BASE, body: "" }, null);
    const spaces = buildServiceFields({ ...BASE, body: "   \n  " }, null);
    const missing = buildServiceFields(BASE, null);
    expect("Email Content" in blank).toBe(false);
    expect("Email Content" in spaces).toBe(false);
    expect("Email Content" in missing).toBe(false);
  });
});

// ADR-0022: selected mail attachments + uploaded files are staged through Convex
// storage and uploaded to Feishu Drive, yielding `file_token`s. The builder maps
// them into the single `Sales Files` column (Feishu field type 17). On WRITE only
// `file_token` is load-bearing — name/type/size/url are read-only and omitted.
describe("buildServiceFields — Sales Files column", () => {
  it("writes attachment file tokens to `Sales Files` as [{ file_token }]", () => {
    const fields = buildServiceFields(
      { ...BASE, attachments: [{ fileToken: "boxcnAAA" }, { fileToken: "boxcnBBB" }] },
      null,
    );
    expect(fields["Sales Files"]).toEqual([
      { file_token: "boxcnAAA" },
      { file_token: "boxcnBBB" },
    ]);
  });

  it("omits `Sales Files` when there are no attachments", () => {
    const empty = buildServiceFields({ ...BASE, attachments: [] }, null);
    const missing = buildServiceFields(BASE, null);
    expect("Sales Files" in empty).toBe(false);
    expect("Sales Files" in missing).toBe(false);
  });
});
