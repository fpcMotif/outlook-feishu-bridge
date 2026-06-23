import { describe, expect, it, vi } from "vitest";
import {
  convertToRestId,
  emailList,
  extractAttachments,
  extractMailData,
  isComposeItem,
  type OfficeLike,
  type ReadItem,
} from "./mailItem";

function stubOffice(
  overrides: {
    convert?: (id: string, version: unknown) => string;
    userEmail?: string;
    supportsAttachments?: boolean;
  } = {},
): OfficeLike {
  return {
    MailboxEnums: { RestVersion: { v2_0: "v2.0" } },
    context: {
      requirements: {
        isSetSupported: () => overrides.supportsAttachments ?? false,
      },
      mailbox: {
        userProfile: { emailAddress: overrides.userEmail ?? "me@fenchem.com" },
        convertToRestId: overrides.convert ?? ((id: string) => `REST(${id})`),
      },
    },
  } as unknown as OfficeLike;
}

describe("isComposeItem", () => {
  it("is true when subject is an async object", () => {
    expect(isComposeItem({ subject: { getAsync: () => {} } })).toBe(true);
  });

  it("is false for read-mode or empty items", () => {
    expect(isComposeItem({ subject: "Quarterly quote" })).toBe(false);
    expect(isComposeItem(undefined as unknown)).toBe(false);
    expect(isComposeItem(null)).toBe(false);
  });
});

describe("emailList", () => {
  it("flattens EmailAddressDetails to plain addresses", () => {
    expect(
      emailList([
        { emailAddress: "a@x.com" },
        { emailAddress: "b@x.com" },
      ] as unknown as Office.EmailAddressDetails[]),
    ).toEqual(["a@x.com", "b@x.com"]);
  });

  it("returns [] when the value is undefined or not an array", () => {
    expect(emailList(undefined as undefined)).toEqual([]);
    expect(emailList({} as unknown as Office.EmailAddressDetails[])).toEqual([]);
  });
});

describe("convertToRestId", () => {
  it("returns an empty string for an empty id", () => {
    expect(convertToRestId(stubOffice(), undefined as undefined)).toBe("");
    expect(convertToRestId(stubOffice(), "")).toBe("");
  });

  it("converts the EWS id to REST v2.0", () => {
    expect(convertToRestId(stubOffice(), "EWS123")).toBe("REST(EWS123)");
  });

  it("passes the v2_0 RestVersion to convertToRestId", () => {
    const convert = vi.fn(() => "rest");
    convertToRestId(stubOffice({ convert }), "EWS123");
    expect(convert).toHaveBeenCalledWith("EWS123", "v2.0");
  });

  it("falls back to the raw id when conversion throws", () => {
    const office = stubOffice({
      convert: () => {
        throw new Error("unsupported");
      },
    });
    expect(convertToRestId(office, "already-rest-id")).toBe("already-rest-id");
  });
});

describe("extractAttachments", () => {
  const item = {
    attachments: [
      { id: "a1", name: "quote.pdf", attachmentType: "file", contentType: "application/pdf", size: 123, isInline: false },
    ],
  } as unknown as ReadItem;

  it("returns [] when the Outlook host does not support attachment metadata", () => {
    expect(extractAttachments(stubOffice({ supportsAttachments: false }), item)).toEqual([]);
  });

  it("maps attachment metadata (attachmentType, not the deprecated contentType) when supported", () => {
    expect(extractAttachments(stubOffice({ supportsAttachments: true }), item)).toEqual([
      { id: "a1", name: "quote.pdf", attachmentType: "file", size: 123, isInline: false },
    ]);
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
    attachments: [
      { id: "a1", name: "quote.pdf", attachmentType: "file", contentType: "application/pdf", size: 123, isInline: false },
    ],
  } as unknown as ReadItem;

  it("maps every field, converts the item id, and preserves supported attachments", () => {
    const data = extractMailData(stubOffice({ supportsAttachments: true }), fullItem, "the body");
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
      attachments: [
        { id: "a1", name: "quote.pdf", attachmentType: "file", size: 123, isInline: false },
      ],
    });
  });

  it("defaults missing optional fields rather than crashing", () => {
    const data = extractMailData(stubOffice({ userEmail: "" }), {} as ReadItem, "");
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
      attachments: [],
    });
  });
});
