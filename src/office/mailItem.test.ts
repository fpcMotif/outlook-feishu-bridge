// Unit tests for the pure Office.js → MailItemData mappers (ADR-0018). The
// Office handle is injected as a stub, so the load-bearing EWS→REST id
// conversion (consumed by Microsoft Graph's message forward, ADR-0017), the
// compose-item rejection, and the email-list flattening are all covered without
// a real Outlook host.
import { describe, it, expect, vi } from "vitest";
import {
  convertToRestId,
  emailList,
  extractMailData,
  isComposeItem,
  type OfficeLike,
  type ReadItem,
} from "./mailItem";

// A stub Office namespace good enough for the mappers. convertToRestId echoes a
// recognisable transformation so tests can assert it was applied.
function stubOffice(
  overrides: {
    convert?: (id: string, version: unknown) => string;
    userEmail?: string;
  } = {},
): OfficeLike {
  return {
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    context: {
      mailbox: {
        userProfile: { emailAddress: overrides.userEmail ?? "me@fenchem.com" },
        convertToRestId:
          overrides.convert ?? ((id: string) => `REST(${id})`),
      },
    },
  } as unknown as OfficeLike;
}

describe("isComposeItem", () => {
  it("is true when subject is an async object (compose/reply window)", () => {
    expect(isComposeItem({ subject: { getAsync: () => {} } })).toBe(true);
  });
  it("is false for a read-mode string subject", () => {
    expect(isComposeItem({ subject: "Quarterly quote" })).toBe(false);
  });
  it("is false for a null/undefined item", () => {
    expect(isComposeItem(undefined)).toBe(false);
    expect(isComposeItem(null)).toBe(false);
  });
});

describe("emailList", () => {
  it("flattens EmailAddressDetails[] to plain addresses", () => {
    expect(
      emailList([
        { emailAddress: "a@x.com" },
        { emailAddress: "b@x.com" },
      ] as unknown as Office.EmailAddressDetails[]),
    ).toEqual(["a@x.com", "b@x.com"]);
  });
  it("returns [] when the value is undefined or not an array", () => {
    expect(emailList(undefined)).toEqual([]);
    expect(emailList({} as unknown as Office.EmailAddressDetails[])).toEqual([]);
  });
});

describe("convertToRestId", () => {
  it("returns '' for an empty/undefined id", () => {
    expect(convertToRestId(stubOffice(), undefined)).toBe("");
    expect(convertToRestId(stubOffice(), "")).toBe("");
  });
  it("converts the EWS id to the REST v2.0 id", () => {
    const office = stubOffice();
    expect(convertToRestId(office, "EWS123")).toBe("REST(EWS123)");
  });
  it("passes the v2_0 RestVersion to convertToRestId", () => {
    const convert = vi.fn(() => "rest");
    convertToRestId(stubOffice({ convert }), "EWS123");
    expect(convert).toHaveBeenCalledWith("EWS123", "v2.0");
  });
  it("falls back to the raw id when conversion throws (e.g. Outlook mobile)", () => {
    const office = stubOffice({
      convert: () => {
        throw new Error("unsupported");
      },
    });
    expect(convertToRestId(office, "already-rest-id")).toBe("already-rest-id");
  });
});

describe("extractMailData", () => {
  const fullItem = {
    subject: "Inquiry",
    from: { emailAddress: "client@acme.com" },
    to: [{ emailAddress: "rep@fenchem.com" }],
    cc: [{ emailAddress: "cc@fenchem.com" }],
    dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
    internetMessageId: "<msg@acme.com>",
    itemId: "EWS-1",
    conversationId: "conv-1",
  } as unknown as ReadItem;

  it("maps every field and converts the item id to a REST id", () => {
    const data = extractMailData(stubOffice(), fullItem, "the body");
    expect(data).toEqual({
      subject: "Inquiry",
      from: "client@acme.com",
      to: ["rep@fenchem.com"],
      cc: ["cc@fenchem.com"],
      body: "the body",
      dateTimeCreated: new Date("2026-05-27T00:00:00Z"),
      internetMessageId: "<msg@acme.com>",
      itemId: "REST(EWS-1)",
      conversationId: "conv-1",
      userEmail: "me@fenchem.com",
    });
  });

  it("defaults missing optional fields rather than crashing", () => {
    const bare = {} as ReadItem;
    const data = extractMailData(stubOffice({ userEmail: "" }), bare, "");
    expect(data).toMatchObject({
      subject: "",
      from: "",
      to: [],
      cc: [],
      body: "",
      dateTimeCreated: null,
      internetMessageId: "",
      itemId: "",
      conversationId: "",
      userEmail: "",
    });
  });
});
