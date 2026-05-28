import type { Coworker } from "../coworkers";

// Dev/preview fallback directory, used only when the live Feishu search is
// unavailable (browser preview has no Convex user session). In real Outlook the
// search hook returns actual coworkers (real open_ids). See ADR-0003.
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

export const RECENTS_KEY = "feishu_recent_coworkers";
