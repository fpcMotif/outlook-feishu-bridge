import { describe, expect, it } from "vitest";

import { assertRealCoworkerOpenIds, isPreviewCoworkerOpenId, poisonedOutboxReason } from "./previewFixtures";

describe("previewFixtures", () => {
  it("flags known preview coworker ids", () => {
    expect(isPreviewCoworkerOpenId("ou_maria")).toBe(true);
    expect(isPreviewCoworkerOpenId("ou_dev_fixture_2")).toBe(true);
  });

  it("allows real Feishu open ids", () => {
    expect(isPreviewCoworkerOpenId("ou_1fa1e520f980675ed46ff40aa177a488")).toBe(false);
  });

  it("rejects preview coworkers before Bitable create", () => {
    expect(() =>
      assertRealCoworkerOpenIds([{ openId: "ou_maria", name: "Maria Hoffmann" }]),
    ).toThrow(/dev preview id/i);
  });

  it("flags dev-sample mail and preview coworkers as poisoned outbox rows", () => {
    expect(
      poisonedOutboxReason({
        internetMessageId: "<dev-sample@fenchem.com>",
        conversationId: "dev-sample",
        selectedCoworkers: [{ openId: "ou_1fa1e520f980675ed46ff40aa177a488" }],
      }),
    ).toMatch(/dev-sample mail/i);
    expect(
      poisonedOutboxReason({
        internetMessageId: "<msg@example.com>",
        conversationId: "conv-1",
        selectedCoworkers: [{ openId: "ou_maria" }],
      }),
    ).toMatch(/preview coworker/i);
    expect(
      poisonedOutboxReason({
        internetMessageId: "<msg@example.com>",
        conversationId: "conv-1",
        selectedCoworkers: [{ openId: "ou_1fa1e520f980675ed46ff40aa177a488" }],
      }),
    ).toBeNull();
  });
});
