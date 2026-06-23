// Shared constants + helpers for the Customer mirror (ADR-0016). No ctx — pure
// config the full-sync orchestration, the search/domain-match action adapters,
// and the registration wrappers all read. Split out of customersMirror.ts so the
// registration file stays under the architecture line limit.
//
// HARD RULE preserved (ADR-0010 / ADR-0012): the mirror only READS the Bitable
// Customer Table. Every constant here describes a READ shape.

export const CUSTOMER_TABLE_ID = "tbl4TE2GV472sKzp";
export const PAGE_SIZE = 500;
// Cache-miss search only needs enough rows to fill the picker and warm the
// mirror around the user's exact query. Keep the full-sync page size at
// Feishu's documented max, but do not pull/write 500 rows on an interactive
// miss when the UI returns at most 50.
export const CACHE_MISS_PAGE_SIZE = 50;
// Mirror Prune scans the whole mirror in bounded pages so each delete mutation
// stays well under Convex's per-transaction write budget; the action paginates
// externally (same shape as the full-sync page loop).
export const PRUNE_PAGE_SIZE = 500;
// Official Feishu limits (open.feishu.cn only - no third-party wrapper, no
// MAX_PAGES cap of our own). The earlier 20-page / 10,000-row ceiling was
// purely ours and silently truncated once the Customer Table grew past it; the
// loop now pages until Feishu itself says has_more=false.
//   - records/search: POST endpoint, max page_size=500, supports page_token,
//     returns has_more/page_token, and is rate-limited to 20 requests/sec.
//   - records/list: GET endpoint with the same page_size/page_token shape, but
//     Feishu marks it historical and recommends records/search instead.
//   docs:
//     records/search:  /document/server-docs/docs/bitable-v1/app-table-record/search
//     records/list:    /document/server-docs/docs/bitable-v1/app-table-record/list
export const MIN_PAGE_REQUEST_INTERVAL_MS = 60;
export const CUSTOMER_FIELD_NAMES = [
  "Account Name",
  "Record Id",
  "域名",
  "全名",
  "Account No.",
  "Country and Regio",
  "Owner",
];

export function requireAppToken(): string {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
  return appToken;
}

// Mirror timing constants. Global + authoritative: the frontend cooldown resets
// on tab reload, so the server is the source of truth for all of these.
export const MIRROR_KICK_COOLDOWN_MS = 15 * 60 * 1000;
// Same as kick: the weekly cron and the on-demand kick share ONE lease so
// concurrent refreshes can never race the prune's delete fan-out.
export const MIRROR_REFRESH_LEASE_MS = MIRROR_KICK_COOLDOWN_MS;
// Per-domain cooldown for matchEmailAndCacheMiss. Same window as the kick.
export const DOMAIN_MATCH_COOLDOWN_MS = 15 * 60 * 1000;
// Max pages per matchEmailAndCacheMiss call (page 2+ only run when page 1 has
// no strict canonical match but has_more=true — superstring rows pushed it off).
export const MAX_CACHE_MISS_PAGES = 3;
