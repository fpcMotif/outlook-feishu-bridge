import { describe, expect, it } from "vitest";

import { deriveMailKey } from "./mailKey";

const USER = "Jenny.Xu@Fenchem.com";

describe("deriveMailKey", () => {
  it("is conversation-scoped when a conversationId is present", () => {
    expect(
      deriveMailKey({
        conversationId: "AAQk-thread-1",
        internetMessageId: "<a@x.com>",
        itemId: "ews-1",
        userEmail: USER,
      }),
    ).toBe("conv:jenny.xu@fenchem.com\nAAQk-thread-1");
  });

  it("keeps sibling messages in the same conversation on the same key", () => {
    const a = deriveMailKey({
      conversationId: "thread-1",
      internetMessageId: "<a@x.com>",
      itemId: "ews-a",
      userEmail: USER,
    });
    const b = deriveMailKey({
      conversationId: "thread-1",
      internetMessageId: "<b@x.com>",
      itemId: "ews-b",
      userEmail: " jenny.xu@fenchem.com ",
    });
    expect(a).toBe(b);
  });

  it("gives different conversations different keys (even same sender thread ids aside)", () => {
    const a = deriveMailKey({
      conversationId: "thread-1",
      internetMessageId: "",
      itemId: "",
      userEmail: USER,
    });
    const b = deriveMailKey({
      conversationId: "thread-2",
      internetMessageId: "",
      itemId: "",
      userEmail: USER,
    });
    expect(a).not.toBe(b);
  });

  it("gives the same conversation in different mailboxes different keys", () => {
    const a = deriveMailKey({
      conversationId: "thread-1",
      internetMessageId: "",
      itemId: "",
      userEmail: "jenny.xu@fenchem.com",
    });
    const b = deriveMailKey({
      conversationId: "thread-1",
      internetMessageId: "",
      itemId: "",
      userEmail: "michael.chen@fenchem.com",
    });
    expect(a).not.toBe(b);
  });

  it("falls back to internetMessageId when conversationId is blank", () => {
    expect(
      deriveMailKey({
        conversationId: "   ",
        internetMessageId: "<msg@x.com>",
        itemId: "ews-1",
        userEmail: USER,
      }),
    ).toBe("msg:jenny.xu@fenchem.com\n<msg@x.com>");
  });

  it("falls back to itemId when conversationId and internetMessageId are blank", () => {
    expect(
      deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "ews-9", userEmail: USER }),
    ).toBe("msg:jenny.xu@fenchem.com\news-9");
  });

  it("returns a stable constant when no identifier is available", () => {
    expect(
      deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "", userEmail: USER }),
    ).toBe("mail:jenny.xu@fenchem.com\nunknown");
    expect(
      deriveMailKey({
        conversationId: undefined as unknown as string,
        internetMessageId: "",
        itemId: "",
        userEmail: "",
      }),
    ).toBe("mail:unknown-user\nunknown");
  });

  it("trims surrounding whitespace before keying", () => {
    expect(
      deriveMailKey({
        conversationId: "  thread-7  ",
        internetMessageId: "",
        itemId: "",
        userEmail: " Jenny.Xu@Fenchem.com ",
      }),
    ).toBe("conv:jenny.xu@fenchem.com\nthread-7");
  });
});
