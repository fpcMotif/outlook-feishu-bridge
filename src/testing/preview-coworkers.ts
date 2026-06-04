import type { Coworker } from "../components/taskpane/coworkers";

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

// Test fixture directory. These made-up coworkers are allowed only when an
// e2e/dev-test harness explicitly opts in; production search must never fall
// back to them. Real user-visible results come only from Feishu Search Users.
// See ADR-0003.
export const PREVIEW_COWORKERS: Coworker[] = [
  { openId: "ou_jenny", name: "Jenny Xu" },
  { openId: "ou_michael", name: "Michael Chen" },
  { openId: "ou_sales_ops", name: "Sales Ops" },
  { openId: "ou_wei", name: "Wei Liang" },
  { openId: "ou_maria", name: "Maria Hoffmann" },
  { openId: "ou_carlos", name: "Carlos Mendez" },
  { openId: "ou_aiko", name: "Aiko Tanaka" },
  { openId: "ou_lena", name: "Lena Fischer" },
];
