const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const WEEK_MS = 7 * DAY_MS;

export interface DevEmailFixture {
  key: string;
  label: string;
  recordId: string;
  detailUrl: string | null;
  coworkerCount: number;
  submittedAtOffsetMs?: number;
}

// Dev-only Email Record fixtures. These are intentionally not Feishu Bitable
// record ids: the dev_fixture_ prefix keeps preview data visually and
// programmatically distinct from live `rec...` rows while exercising the same
// success-screen timestamp surface fed by Convex Email Records.
export const DEV_EMAIL_FIXTURES: readonly DevEmailFixture[] = [
  {
    key: "fresh",
    label: "[DEV] Fresh Convex email record",
    recordId: "dev_fixture_email_sync_fresh",
    detailUrl:
      "https://feishu.cn/base/app?table=tbl&record=dev_fixture_email_sync_fresh",
    coworkerCount: 1,
  },
  {
    key: "same-day",
    label: "[DEV] Same-day Convex email record",
    recordId: "dev_fixture_email_sync_same_day",
    detailUrl:
      "https://feishu.cn/base/app?table=tbl&record=dev_fixture_email_sync_same_day",
    coworkerCount: 1,
    submittedAtOffsetMs: 3 * HOUR_MS,
  },
  {
    key: "week-old",
    label: "[DEV] Week-old Convex email record",
    recordId: "dev_fixture_email_sync_week_old",
    detailUrl:
      "https://feishu.cn/base/app?table=tbl&record=dev_fixture_email_sync_week_old",
    coworkerCount: 2,
    submittedAtOffsetMs: WEEK_MS,
  },
  {
    key: "backup-only",
    label: "[DEV] Backup-only Convex email record",
    recordId: "dev_fixture_email_backup_only",
    detailUrl: null,
    coworkerCount: 0,
    submittedAtOffsetMs: 2 * WEEK_MS + DAY_MS,
  },
];

export function findDevEmailFixture(key: string | null): DevEmailFixture {
  return DEV_EMAIL_FIXTURES.find((fixture) => fixture.key === key) ?? DEV_EMAIL_FIXTURES[0]!;
}

export function submittedAtForDevEmailFixture(
  fixture: DevEmailFixture,
  now = Date.now(),
): number | undefined {
  if (fixture.submittedAtOffsetMs === undefined) return undefined;
  return now - fixture.submittedAtOffsetMs;
}
