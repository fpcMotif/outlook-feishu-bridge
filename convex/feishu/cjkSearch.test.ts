import { describe, expect, it } from "vitest";

import { cjkBigramBlob, toSearchQueryString } from "./cjkSearch";
import { buildSearchBlob } from "./customerMirrorRows";

// A faithful-enough stand-in for Convex's Tantivy SimpleTokenizer: lowercase,
// then split on every character that is not a letter or a digit. CJK ideographs
// ARE letters (\p{L}), so a maximal CJK run survives as ONE token — exactly the
// behaviour we observed live (中云(上海)化妆品有限公司 -> 中云 / 上海 / 化妆品有限公司).
function simpleTokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

// Convex returns a document if ANY query term matches a token; the final term
// matches as a prefix. This models "would the mirror surface this row at all".
function mirrorWouldMatch(blob: string, queryTokens: string): boolean {
  const tokens = new Set(simpleTokenize(blob));
  const terms = simpleTokenize(queryTokens);
  if (terms.length === 0) return false;
  return terms.some((term, i) => {
    if (tokens.has(term)) return true;
    const isLast = i === terms.length - 1;
    return isLast && [...tokens].some((t) => t.startsWith(term));
  });
}

describe("cjkBigramBlob", () => {
  it("returns empty for Latin-only values so the blob stays unchanged", () => {
    expect(cjkBigramBlob("Acme Chemicals AG")).toBe("");
    expect(cjkBigramBlob("ACME-001")).toBe("");
    expect(cjkBigramBlob("acme.example")).toBe("");
  });

  it("emits overlapping character bigrams for a CJK run", () => {
    expect(cjkBigramBlob("化妆品")).toBe("化妆 妆品");
  });

  it("bridges intra-field punctuation so a cross-boundary substring can match", () => {
    // The real failing row. Stripping "(", ")" first lets 海化 bridge the gap.
    const blob = cjkBigramBlob("中云(上海)化妆品有限公司");
    expect(blob).toContain("上海");
    expect(blob).toContain("海化");
    expect(blob).toContain("化妆");
    expect(blob).toContain("妆品");
  });

  it("returns empty when the value has no CJK at all", () => {
    expect(cjkBigramBlob("123 / 456")).toBe("");
  });
});

describe("toSearchQueryString", () => {
  it("passes Latin queries through untouched (prefix matching preserved)", () => {
    expect(toSearchQueryString("Novus")).toBe("Novus");
    expect(toSearchQueryString("Novus Foods")).toBe("Novus Foods");
  });

  it("bigram-expands a CJK query", () => {
    expect(toSearchQueryString("上海化妆品")).toBe("上海 海化 化妆 妆品");
  });

  it("keeps a single CJK character as a unigram", () => {
    expect(toSearchQueryString("化")).toBe("化");
  });

  it("interleaves Latin words and CJK bigrams in order", () => {
    expect(toSearchQueryString("acme 化妆")).toBe("acme 化妆");
  });

  it("collapses an all-punctuation query to empty so callers treat it as a miss", () => {
    expect(toSearchQueryString("()（）/")).toBe("");
  });

  it("caps the expansion at Convex's 16-term ceiling", () => {
    // 20 CJK chars -> 19 bigrams, truncated to the leading 16.
    const long = "一二三四五六七八九十一二三四五六七八九十";
    const terms = toSearchQueryString(long).split(" ");
    expect(terms).toHaveLength(16);
  });
});

describe("split-value search regression (the bug this fixes)", () => {
  const ROW = buildSearchBlob({
    recordId: "rec_zhongyun",
    name: "中云(上海)化妆品有限公司",
    owner: null,
  });

  it("the OLD raw-query path missed this row (reproduces the reported slowness)", () => {
    // "上海化妆品" spans the (上海)化妆品 punctuation: as a single raw token it
    // prefix-matches none of 中云 / 上海 / 化妆品有限公司, so the mirror returned 0
    // and the SPA fell through to the slow live Feishu call.
    expect(mirrorWouldMatch(ROW, "上海化妆品")).toBe(false);
  });

  it("the bigram-expanded query now matches the row on the fast mirror path", () => {
    expect(mirrorWouldMatch(ROW, toSearchQueryString("上海化妆品"))).toBe(true);
  });

  it("mid-name CJK substrings match too (parity with Feishu `contains`)", () => {
    // "化妆品" sits mid-token in many names; the bigram path finds them.
    expect(mirrorWouldMatch(ROW, toSearchQueryString("化妆品"))).toBe(true);
  });
});
