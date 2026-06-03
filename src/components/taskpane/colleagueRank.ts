// PURE client-side colleague matcher for the preload picker (ADR-0024). The
// whole directory (<=800 rows) is preloaded once; this ranks it in memory on
// every keystroke — zero network, zero Convex, no manual cache. Pinyin keys are
// precomputed at sync time (convex/feishu/pinyinTokens.ts), so NO pinyin-pro
// dictionary ships to the SPA; this module only does plain string matching.
// No React, no I/O → unit-tested with plain vitest (ADR-0019).

// The slim row preloaded from feishu/contactsMirror:listForPicker. Mirrors
// ContactPickerRow on the server; pinyin fields are always strings ("" when the
// name has no Han).
export interface ColleagueRow {
  openId: string;
  name: string;
  email?: string;
  department?: string;
  pinyinFull: string;
  pinyinInitials: string;
  pinyinAlts: string;
  nameFold: string;
}

// A single Latin letter is too noisy to search; a single CJK character is a
// meaningful unit, so 1-char CJK queries ARE allowed (e.g. 冬 must find 陈冬冬).
const MIN_QUERY_LENGTH = 2;
const DEFAULT_LIMIT = 20;
// CJK ranges (Han + kana + Hangul), mirroring convex/feishu/cjkSearch.ts. Inlined
// so the SPA never imports convex/.
const CJK_CHAR = /[㐀-䶿一-鿿豈-﫿぀-ヿ가-힯]/;

function meetsMinLength(q: string): boolean {
  if (q.length >= MIN_QUERY_LENGTH) return true;
  return q.length === 1 && CJK_CHAR.test(q);
}

// Match tiers, strongest first. A query that IS a whole key (name / glued full
// pinyin / initials / email) outranks a prefix, which outranks an initials
// substring, which outranks a loose substring. Keeps a true "pengaili" / "pal"
// hit above a colleague who merely contains those letters.
const SCORE_EXACT = 100;
const SCORE_PREFIX = 80;
const SCORE_INITIALS_SUBSTRING = 60;
const SCORE_SUBSTRING = 40;
const SCORE_NONE = 0;

// Same fold as the server's foldName (NFKC + trim + lowercase). Reimplemented
// here so the SPA never imports convex/.
export function foldQuery(query: string): string {
  return query.normalize("NFKC").trim().toLowerCase();
}

function tokens(value: string): string[] {
  return value ? value.split(" ").filter(Boolean) : [];
}

function scoreColleague(q: string, row: ColleagueRow): number {
  const fullTokens = tokens(row.pinyinFull);
  const altTokens = tokens(row.pinyinAlts);
  const gluedFull = fullTokens.at(-1) ?? "";
  const emailFold = row.email ? row.email.toLowerCase() : "";

  if (q === row.nameFold || q === row.pinyinInitials || q === gluedFull || q === emailFold) {
    return SCORE_EXACT;
  }
  if (
    row.nameFold.startsWith(q) ||
    (row.pinyinInitials !== "" && row.pinyinInitials.startsWith(q)) ||
    (emailFold !== "" && emailFold.startsWith(q)) ||
    fullTokens.some((token) => token.startsWith(q)) ||
    altTokens.some((token) => token.startsWith(q))
  ) {
    return SCORE_PREFIX;
  }
  if (row.pinyinInitials.includes(q)) {
    return SCORE_INITIALS_SUBSTRING;
  }
  if (
    row.nameFold.includes(q) ||
    row.pinyinFull.includes(q) ||
    row.pinyinAlts.includes(q) ||
    emailFold.includes(q)
  ) {
    return SCORE_SUBSTRING;
  }
  return SCORE_NONE;
}

export interface RankOptions {
  /** Cap the result list (default 20). */
  limit?: number;
  /** Department to float to the top within a score tie (sales-scope precedence). */
  preferredDepartment?: string;
}

/**
 * Rank colleagues for a query. Returns [] for a blank/<2-char query. Stable,
 * deterministic ordering: score desc, then preferred department, then name asc.
 */
export function rankColleagues(
  query: string,
  rows: readonly ColleagueRow[],
  options: RankOptions = {},
): ColleagueRow[] {
  const q = foldQuery(query);
  if (!meetsMinLength(q)) return [];
  const limit = options.limit ?? DEFAULT_LIMIT;
  const preferred = options.preferredDepartment;

  const matched: { row: ColleagueRow; score: number }[] = [];
  for (const row of rows) {
    const score = scoreColleague(q, row);
    if (score > SCORE_NONE) matched.push({ row, score });
  }
  matched.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (preferred !== undefined) {
      const aPref = a.row.department === preferred ? 0 : 1;
      const bPref = b.row.department === preferred ? 0 : 1;
      if (aPref !== bPref) return aPref - bPref;
    }
    return a.row.name.localeCompare(b.row.name);
  });
  return matched.slice(0, limit).map((entry) => entry.row);
}
