import { describe, expect, it } from "vitest";

import { findDevEmailFixture } from "./devEmailFixtures";
import { buildDevEmailRecordFixture } from "./devEmailRecordSeed";

const NOW = new Date("2026-06-02T05:00:00Z").getTime();

describe("dev Email Record seed rows", () => {
  it("builds Convex Email Record rows tagged as dev fixtures", () => {
    const row = buildDevEmailRecordFixture(findDevEmailFixture("week-old"), NOW);

    expect(row).toMatchObject({
      subject: "[DEV] Week-old Convex email record date display check",
      internetMessageId: "<dev_fixture_email_sync_week_old@dev.fixture.fenchem>",
      conversationId: "dev_fixture_email_sync_week_old",
      requestSyncKey: "fanpc@fenchem.com\ndev_fixture_email_sync_week_old",
      bitableRecordId: "dev_fixture_email_sync_week_old",
      bitableSyncStatus: "synced",
      bitableLastAttemptAt: new Date("2026-05-26T05:00:00Z").getTime(),
    });
    expect(row.selectedCoworkers).toHaveLength(2);
    expect(row.selectedCustomer.recordId).toBe("dev_fixture_fanpc_customer");
  });
});
