import { describe, expect, it } from "vitest";

import {
  buildSelfForwardComment,
  buildSelfForwardForwardBody,
} from "./selfForwardMessage";

describe("buildSelfForwardComment", () => {
  it("renders a plain-text Bitable-sync preamble", () => {
    expect(
      buildSelfForwardComment({
        selfEmail: "fanpc@fenchem.com",
        customerName: "Bayer Pharma",
        clientEmail: "m.hoffmann@bayerpharma.de",
        requestSelections: [
          { requestType: "Quotation", note: "Need a quarterly L-Carnitine quote." },
          { requestType: "Sample", note: "1 kg, USP grade." },
        ],
      }),
    ).toBe(
      [
        "Synced to Feishu Bitable",
        "Client: Bayer Pharma",
        "Client email: m.hoffmann@bayerpharma.de",
        "Request types: Quotation, Sample",
        "Quotation note: Need a quarterly L-Carnitine quote.",
        "Sample note: 1 kg, USP grade.",
        "------------------",
      ].join("\n"),
    );
  });

  it("falls back to a minimal preamble when no customer or requests are present", () => {
    expect(buildSelfForwardComment({ selfEmail: "fanpc@fenchem.com" })).toBe(
      ["Synced to Feishu Bitable", "------------------"].join("\n"),
    );
  });
});

describe("buildSelfForwardForwardBody", () => {
  it("addresses the native forward to the user's own mailbox", () => {
    const body = buildSelfForwardForwardBody({
      selfEmail: "fanpc@fenchem.com",
      customerName: "Bayer Pharma",
      requestSelections: [{ requestType: "Quotation", note: "Quote please" }],
    });
    expect(body.toRecipients).toEqual([
      { emailAddress: { address: "fanpc@fenchem.com" } },
    ]);
    expect(body.comment).toContain("Synced to Feishu Bitable");
    expect(body.comment).toContain("Client: Bayer Pharma");
  });
});
