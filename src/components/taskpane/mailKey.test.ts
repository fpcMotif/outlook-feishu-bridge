import { describe, expect, it } from "vitest";

import { deriveMailKey } from "./mailKey";

const BASE = {
  conversationId: "conv-1",
  internetMessageId: "<m1@example.com>",
  itemId: "item-1",
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
    const a = deriveMailKey({ conversationId: "conv-1", internetMessageId: "", itemId: "" });
    const b = deriveMailKey({ conversationId: "conv-2", internetMessageId: "", itemId: "" });
    expect(a).not.toBe(b);
  });

  it("falls back to the message id when conversationId is empty", () => {
    const a = deriveMailKey({ conversationId: "", internetMessageId: "<m1@x>", itemId: "item-1" });
    const b = deriveMailKey({ conversationId: "  ", internetMessageId: "<m2@x>", itemId: "item-1" });
    expect(a).not.toBe(b);
    expect(a).toContain("m1");
  });

  it("falls back to itemId when conversationId and internetMessageId are empty", () => {
    const a = deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "item-1" });
    const b = deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "item-2" });
    expect(a).not.toBe(b);
  });

  it("returns a stable constant when every id is empty (degraded host)", () => {
    const a = deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "" });
    const b = deriveMailKey({ conversationId: "", internetMessageId: "", itemId: "" });
    expect(a).toBe(b);
  });

  it("is stable for identical input", () => {
    expect(deriveMailKey(BASE)).toBe(deriveMailKey({ ...BASE }));
  });
});
