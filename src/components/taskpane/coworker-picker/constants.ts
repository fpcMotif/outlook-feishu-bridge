import type { Coworker } from "../coworkers";

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

export const RECENTS_KEY = "feishu_recent_coworkers";
export const SEARCH_DEBOUNCE_MS = 250;
export const MIN_REMOTE_COWORKER_SEARCH_LENGTH = 2;
export const MIN_EMAIL_FIELD_HEIGHT = 32;
