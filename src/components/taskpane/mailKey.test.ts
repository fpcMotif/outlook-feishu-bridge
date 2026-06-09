import { describe, expect, it } from "vitest";

import { deriveMailKey } from "./mailKey";

const BASE = {
  conversationId: "conv-1",
  internetMessageId: "<m1@example.com>",
  itemId: "item-1",
  userEmail: "Rep@Fenchem.com",
};

describe("deriveMailKey", () => {
  it("is conversation-scoped: sibling messages in one thread share a key", () => {
    const a = deriveMailKey(BASE);
    const b = deriveMailKey({
      ...BASE,
      internetMessageId: "<m2@example.com>",
      itemId: "item-2",
    });
    expect(a).toBe(b); // same conversation => no remount => request survives
  });

  it("changes when the conversation changes (clean slate on thread switch)", () => {
    expect(deriveMailKey(BASE)).not.toBe(
      deriveMailKey({ ...BASE, conversationId: "conv-2" }),
    );
  });

  it("never keys off the sender alone (same sender, different thread must differ)", () => {
    const a = deriveMailKey({
      conversationId: "conv-1",
      internetMessageId: "",
      itemId: "",
      userEmail: BASE.userEmail,
    });
    const b = deriveMailKey({
      conversationId: "conv-2",
      internetMessageId: "",
      itemId: "",
      userEmail: BASE.userEmail,
    });
    expect(a).not.toBe(b);
  });

  it("includes the normalized mailbox so shared conversation ids do not collide", () => {
    const a = deriveMailKey({ ...BASE, userEmail: "  Rep@Fenchem.com " });
    const b = deriveMailKey({ ...BASE, userEmail: "other@fenchem.com" });
    expect(a).toContain("rep@fenchem.com");
    expect(a).not.toBe(b);
  });

  it("falls back to the message id when conversationId is empty", () => {
    const a = deriveMailKey({
      conversationId: "",
      internetMessageId: "<m1@x>",
      itemId: "item-1",
      userEmail: BASE.userEmail,
    });
    const b = deriveMailKey({
      conversationId: "  ",
      internetMessageId: "<m2@x>",
      itemId: "item-1",
      userEmail: BASE.userEmail,
    });
    expect(a).not.toBe(b);
    expect(a).toContain("m1");
  });

  it("falls back to itemId when conversationId and internetMessageId are empty", () => {
    const a = deriveMailKey({
      conversationId: "",
      internetMessageId: "",
      itemId: "item-1",
      userEmail: BASE.userEmail,
    });
    const b = deriveMailKey({
      conversationId: "",
      internetMessageId: "",
      itemId: "item-2",
      userEmail: BASE.userEmail,
    });
    expect(a).not.toBe(b);
  });

  it("returns a stable constant when every id is empty (degraded host)", () => {
    const a = deriveMailKey({
      conversationId: "",
      internetMessageId: "",
      itemId: "",
      userEmail: BASE.userEmail,
    });
    const b = deriveMailKey({
      conversationId: "",
      internetMessageId: "",
      itemId: "",
      userEmail: BASE.userEmail,
    });
    expect(a).toBe(b);
  });

  it("is stable for identical input", () => {
    expect(deriveMailKey(BASE)).toBe(deriveMailKey({ ...BASE }));
  });
});
