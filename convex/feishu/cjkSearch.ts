// CJK-aware tokenization shim for the Customer mirror search index (ADR-0016).
//
// Convex's search index tokenizes with Tantivy's SimpleTokenizer, which splits
// ONLY on whitespace and punctuation, lowercases, and prefix-matches the final
// term (https://docs.convex.dev/search/text-search — "works best with English
// or other Latin-script languages"). Chinese has no inter-word spaces, so that
// tokenizer indexes each run of CJK characters as ONE token and can only
// prefix-match it. A natural query like the Chinese for "Shanghai cosmetics" —
// which spans the parenthesised "(Shanghai)cosmetics" inside a full company
// name — is itself a single token that prefix-matches none of that row's
// punctuation-split tokens, so the mirror returns zero hits and the SPA pays
// the slow live-Feishu fallback for nothing (observed: mirror miss + ~2.7 s
// live -> 0 results, slower than a direct call).
//
// The standard fix for a whitespace tokenizer over CJK is character-bigram
// indexing — the same approach as Lucene's CJKBigramFilter and Elasticsearch's
// CJK analyzer: index every overlapping 2-character window of the CJK text so a
// substring query becomes an ordinary term match. We bigram both the indexed
// blob ({@link cjkBigramBlob}) and the query ({@link toSearchQueryString}) so
// the two line up. Latin/digit content is left untouched — it already works
// with SimpleTokenizer.

// CJK ranges we treat as having no internal word boundaries: CJK Unified
// Ideographs (U+4E00-U+9FFF) plus Extension A (U+3400-U+4DBF) and Compatibility
// (U+F900-U+FAFF), Japanese kana (U+3040-U+30FF), and Korean Hangul syllables
// (U+AC00-U+D7AF). Latin letters, digits, and punctuation are deliberately
// excluded so they keep SimpleTokenizer's native behavior.
const CJK = "㐀-䶿一-鿿豈-﫿぀-ヿ가-힯";
const NON_CJK = new RegExp(`[^${CJK}]+`, "g");
const IS_CJK_CHAR = new RegExp(`[${CJK}]`);
// One segment = a maximal CJK run OR a maximal non-CJK run, so "acme 化妆"
// yields ["acme ", "化妆"] in order. Non-CJK segments are then word-split below.
const SEGMENT = new RegExp(`[${CJK}]+|[^${CJK}]+`, "g");
// Within a non-CJK segment, tokenize the way Convex's SimpleTokenizer does:
// split on every non-letter/non-digit, dropping punctuation and whitespace.
const NON_WORD = /[^\p{L}\p{N}]+/u;

// Convex caps a single search expression at 16 terms; overflow throws. A long
// CJK query truncates to its leading bigrams, which are still discriminating.
const MAX_SEARCH_TERMS = 16;

/** Overlapping 2-char windows of one CJK run (the unigram itself if length 1). */
function bigramsOfRun(run: string): string[] {
  if (run.length <= 1) return run === "" ? [] : [run];
  const out: string[] = [];
  for (let i = 0; i < run.length - 1; i += 1) {
    out.push(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Expand one field's CJK content into space-separated character bigrams, with
 * intra-field non-CJK (punctuation, spaces, Latin) stripped first so a bigram
 * bridges separators like the parentheses in a "(City)Product Co." style name.
 * Returns "" when the value holds no CJK, so callers can drop it cleanly from
 * the blob.
 */
export function cjkBigramBlob(value: string): string {
  const cjkOnly = value.replace(NON_CJK, "");
  return bigramsOfRun(cjkOnly).join(" ");
}

/**
 * Convert a user query into the token string handed to Convex's
 * `.search("searchBlob", …)`. CJK runs become overlapping bigrams (so they line
 * up with {@link cjkBigramBlob}); Latin/digit words pass through unchanged and
 * keep prefix matching on the final term. Capped at Convex's 16-term ceiling.
 * Returns "" when the query has no searchable content (e.g. all punctuation),
 * which callers treat as a mirror miss.
 */
export function toSearchQueryString(query: string): string {
  const terms: string[] = [];
  for (const segment of query.match(SEGMENT) ?? []) {
    const segmentTerms = IS_CJK_CHAR.test(segment[0])
      ? bigramsOfRun(segment)
      : segment.split(NON_WORD).filter(Boolean);
    for (const term of segmentTerms) {
      terms.push(term);
      if (terms.length >= MAX_SEARCH_TERMS) break;
    }
    if (terms.length >= MAX_SEARCH_TERMS) break;
  }
  return terms.slice(0, MAX_SEARCH_TERMS).join(" ");
}
