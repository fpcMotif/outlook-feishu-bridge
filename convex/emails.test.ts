/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { describe, expect, it, beforeEach } from "vitest";

import schema from "./schema";
import { api, internal } from "./_generated/api";

const modules = import.meta.glob("./**/*.*s");

const mockEmailRecord = {
  subject: "Test Subject",
  from: "alice@example.com",
  to: ["bob@example.com"],
  cc: [],
  bodyPreview: "Test Body",
  internetMessageId: "<test-msg-1@example.com>",
  sentToBot: false,
  sentToChat: false,
  sentToBitable: true,
};

describe("storeEmailRecord", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("should store an email record", async () => {
    await t.mutation(internal.emails.storeEmailRecord, mockEmailRecord);

    const emailRecord = await t.query(api.emails.getByInternetMessageId, {
      internetMessageId: mockEmailRecord.internetMessageId,
    });

    expect(emailRecord).not.toBeNull();
    expect(emailRecord?.subject).toBe(mockEmailRecord.subject);
    expect(emailRecord?.from).toBe(mockEmailRecord.from);
  });
});

describe("getByInternetMessageId", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("should get an email record by internet message id", async () => {
     await t.mutation(internal.emails.storeEmailRecord, mockEmailRecord);

    const emailRecord = await t.query(api.emails.getByInternetMessageId, {
      internetMessageId: mockEmailRecord.internetMessageId,
    });

    expect(emailRecord).not.toBeNull();
    expect(emailRecord?.internetMessageId).toBe(mockEmailRecord.internetMessageId);
  });
});

describe("listRecent", () => {
  let t: ReturnType<typeof convexTest>;

  beforeEach(() => {
    t = convexTest(schema, modules);
  });

  it("should list recent email records", async () => {
    await t.mutation(internal.emails.storeEmailRecord, {
      ...mockEmailRecord,
      internetMessageId: "<msg-1@example.com>",
      subject: "Message 1",
    });

    // Wait a tiny bit so createdAt is different
    await new Promise<void>((resolve) => {
      setTimeout(() => {
        resolve();
      }, 10);
    });

    await t.mutation(internal.emails.storeEmailRecord, {
      ...mockEmailRecord,
      internetMessageId: "<msg-2@example.com>",
      subject: "Message 2",
    });

    const recent = await t.query(api.emails.listRecent, {});

    expect(recent.length).toBe(2);
    // Since it's ordered by desc by default, the most recent (Message 2) is first
    expect(recent[0]?.subject).toBe("Message 2");
    expect(recent[1]?.subject).toBe("Message 1");
  });
});
