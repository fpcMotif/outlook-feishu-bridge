// Coverage top-up for selfForwardMessage.ts. selfForwardMessage.test.ts covers
// the full preamble and the minimal fallback; this file exercises the remaining
// trim guards: a whitespace-only customerName/clientEmail is dropped, and a
// request whose note is blank/whitespace contributes a "Request types:" line but
// no per-request note line.

import { describe, expect, it } from "vitest";

import { buildSelfForwardComment } from "./selfForwardMessage";

describe("buildSelfForwardComment trim guards", () => {
  it("drops a whitespace-only customerName and clientEmail (trim falsey branch)", () => {
    expect(
      buildSelfForwardComment({
        selfEmail: "fanpc@fenchem.com",
        customerName: "   ",
        clientEmail: "\t\n",
      }),
    ).toBe(["Synced to Feishu Bitable", "------------------"].join("\n"));
  });

  it("lists request types but omits the per-request note line when the note is blank", () => {
    expect(
      buildSelfForwardComment({
        selfEmail: "fanpc@fenchem.com",
        requestSelections: [
          { requestType: "Quotation", note: "   " },
          { requestType: "Sample", note: "1 kg, USP grade." },
        ],
      }),
    ).toBe(
      [
        "Synced to Feishu Bitable",
        "Request types: Quotation, Sample",
        // Quotation note is whitespace-only -> skipped; Sample note kept.
        "Sample note: 1 kg, USP grade.",
        "------------------",
      ].join("\n"),
    );
  });

  it("keeps a present customerName but omits clientEmail when only the email is blank", () => {
    expect(
      buildSelfForwardComment({
        selfEmail: "fanpc@fenchem.com",
        customerName: "Bayer Pharma",
        clientEmail: "  ",
      }),
    ).toBe(
      [
        "Synced to Feishu Bitable",
        "Client: Bayer Pharma",
        "------------------",
      ].join("\n"),
    );
  });

  it("treats an empty requestSelections array like no requests (length===0 branch)", () => {
    expect(
      buildSelfForwardComment({
        selfEmail: "fanpc@fenchem.com",
        requestSelections: [],
      }),
    ).toBe(["Synced to Feishu Bitable", "------------------"].join("\n"));
  });
});
