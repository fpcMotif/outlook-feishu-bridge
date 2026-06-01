import { describe, expect, it } from "vitest";

import { getBitableSyncByConversation } from "./emails";

type EmailRecordFixture = {
  requestSyncKey?: string;
  conversationId?: string;
  userEmail?: string;
  bitableRecordId?: string;
  selectedCoworkers?: Array<{ openId: string; name: string }>;
  bitableLastAttemptAt?: number;
  createdAt: number;
};

type EqConstraint = { field: keyof EmailRecordFixture; value: string };

function makeQueryCtx(records: EmailRecordFixture[]) {
  return {
    db: {
      query: (table: string) => {
        expect(table).toBe("emailRecords");
        let constraint: EqConstraint | null = null;
        let desc = false;
        const chain = {
          withIndex: (_indexName: string, select: (q: { eq: (field: keyof EmailRecordFixture, value: string) => EqConstraint }) => EqConstraint) => {
            constraint = select({ eq: (field, value) => ({ field, value }) });
            return chain;
          },
          order: (direction: "asc" | "desc") => {
            desc = direction === "desc";
            return chain;
          },
          first: async () => matchingRecords(records, constraint, desc)[0] ?? null,
          take: async (limit: number) => matchingRecords(records, constraint, desc).slice(0, limit),
        };
        return chain;
      },
    },
  };
}

function matchingRecords(
  records: EmailRecordFixture[],
  constraint: EqConstraint | null,
  desc: boolean,
) {
  const filtered = constraint
    ? records.filter((record) => record[constraint.field] === constraint.value)
    : records;
  return desc ? filtered.toReversed() : filtered;
}

const handler = (
  getBitableSyncByConversation as unknown as {
    _handler: (
      ctx: ReturnType<typeof makeQueryCtx>,
      args: { userEmail: string; conversationId: string },
    ) => Promise<unknown>;
  }
)._handler;

describe("getBitableSyncByConversation", () => {
  it("returns the synced Base row for the current mailbox conversation", async () => {
    const ctx = makeQueryCtx([
      {
        requestSyncKey: "rep@example.com\nconv-1",
        conversationId: "conv-1",
        userEmail: "rep@example.com",
        bitableRecordId: "rec_service_1",
        selectedCoworkers: [{ openId: "ou_jenny", name: "Jenny Xu" }],
        bitableLastAttemptAt: 1_716_000_000_111,
        createdAt: 1_716_000_000_000,
      },
    ]);

    await expect(
      handler(ctx, { userEmail: " Rep@Example.COM ", conversationId: " conv-1 " }),
    ).resolves.toEqual({
      recordId: "rec_service_1",
      detailUrl: null,
      coworkerCount: 1,
      syncedAt: 1_716_000_000_111,
    });
  });

  it("falls back to bounded conversation lookup for older rows without requestSyncKey", async () => {
    const ctx = makeQueryCtx([
      {
        conversationId: "conv-1",
        userEmail: "someone-else@example.com",
        bitableRecordId: "rec_other",
        createdAt: 1_716_000_000_000,
      },
      {
        conversationId: "conv-1",
        userEmail: "rep@example.com",
        bitableRecordId: "rec_legacy",
        selectedCoworkers: [
          { openId: "ou_jenny", name: "Jenny Xu" },
          { openId: "ou_dave", name: "Dave Lin" },
        ],
        createdAt: 1_716_000_000_222,
      },
    ]);

    await expect(
      handler(ctx, { userEmail: "rep@example.com", conversationId: "conv-1" }),
    ).resolves.toMatchObject({
      recordId: "rec_legacy",
      coworkerCount: 2,
      syncedAt: 1_716_000_000_222,
    });
  });

  it("returns null for pending backups that do not have a Base row yet", async () => {
    const ctx = makeQueryCtx([
      {
        requestSyncKey: "rep@example.com\nconv-1",
        conversationId: "conv-1",
        userEmail: "rep@example.com",
        createdAt: 1_716_000_000_000,
      },
    ]);

    await expect(
      handler(ctx, { userEmail: "rep@example.com", conversationId: "conv-1" }),
    ).resolves.toBeNull();
  });

  it("returns null for blank mailbox or conversation identity", async () => {
    const ctx = makeQueryCtx([]);

    await expect(handler(ctx, { userEmail: " ", conversationId: "conv-1" })).resolves.toBeNull();
    await expect(handler(ctx, { userEmail: "rep@example.com", conversationId: " " })).resolves.toBeNull();
  });
});
