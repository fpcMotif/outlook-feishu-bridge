// Keep in sync with convex/feishu/previewFixtures.ts and TaskPane dev user ids.
const PREVIEW_COWORKER_OPEN_IDS = new Set([
  "ou_jenny",
  "ou_michael",
  "ou_sales_ops",
  "ou_wei",
  "ou_maria",
  "ou_carlos",
  "ou_aiko",
  "ou_lena",
  "ou_dev",
]);

export function isPreviewCoworkerOpenId(openId: string | undefined | null): boolean {
  if (!openId) return false;
  if (PREVIEW_COWORKER_OPEN_IDS.has(openId)) return true;
  return openId.startsWith("ou_dev_fixture_");
}