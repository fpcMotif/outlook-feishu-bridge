import { describe, expect, it } from "vitest";

import {
  DEV_EMAIL_FIXTURES,
  findDevEmailFixture,
  submittedAtForDevEmailFixture,
} from "./devEmailFixtures";

const NOW = new Date("2026-06-02T05:00:00Z").getTime();

describe("dev Email Record fixtures", () => {
  it("keeps every fixture visibly separate from real Feishu record ids", () => {
    expect(DEV_EMAIL_FIXTURES).toHaveLength(4);
    expect(DEV_EMAIL_FIXTURES.every((fixture) => fixture.recordId.startsWith("dev_fixture_"))).toBe(
      true,
    );
    expect(DEV_EMAIL_FIXTURES.every((fixture) => fixture.label.startsWith("[DEV] "))).toBe(
      true,
    );
  });

  it("resolves fixtures by key instead of accepting real-looking record ids", () => {
    expect(findDevEmailFixture("week-old").recordId).toBe("dev_fixture_email_sync_week_old");
    expect(findDevEmailFixture("rec_real_feishu_row").recordId).toBe(
      "dev_fixture_email_sync_fresh",
    );
  });

  it("computes preview timestamps from deterministic age offsets", () => {
    const weekOld = findDevEmailFixture("week-old");

    expect(submittedAtForDevEmailFixture(weekOld, NOW)).toBe(
      new Date("2026-05-26T05:00:00Z").getTime(),
    );
  });
});
