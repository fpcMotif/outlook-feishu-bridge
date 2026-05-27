import { describe, expect, it } from "vitest";

import { buildServiceRecordFields } from "./bitable";

describe("buildServiceRecordFields", () => {
  it("maps request selections to writable Bitable service columns", () => {
    expect(
      buildServiceRecordFields({
        clientEmail: "verify@zzz-delete-me.invalid",
        requestSelections: [
          { requestType: "Quotation", note: "Need quarterly pricing." },
        ],
      }),
    ).toEqual({
      "Quotation Note": "Need quarterly pricing.",
      "Request Remark": "Client email: verify@zzz-delete-me.invalid\nClient domain: zzz-delete-me.invalid\n\nQuotation: Need quarterly pricing.",
      "Request Type": ["Qutation"],
    });
  });

  it("writes the chosen coworker and current sales user as person-field ids", () => {
    expect(
      buildServiceRecordFields({
        clientEmail: "client@example.com",
        requestSelections: [{ requestType: "Sample", note: "Send 50g." }],
        selectedCoworkers: [
          { openId: "ou_real_jenny", name: "Jenny Xu" },
          { openId: "ou_real_michael", name: "Michael Chen" },
        ],
        salesUser: { openId: "ou_sales_user", name: "Sales User" },
      }),
    ).toMatchObject({
      "Co Worker": [{ id: "ou_real_jenny" }],
      Sales: [{ id: "ou_sales_user" }],
    });
  });

  it("writes Client only when a linked customer record id is available", () => {
    expect(
      buildServiceRecordFields({
        clientEmail: "client@example.com",
        clientRecordId: "rec_customer",
        requestSelections: [{ requestType: "Sample", note: "Send 50g." }],
      }),
    ).toMatchObject({
      Client: ["rec_customer"],
    });
  });
});
