import { describe, expect, it } from "vitest";

import { foldQuery, rankColleagues, type ColleagueRow } from "./colleagueRank";

// Pinyin fields here are the verified buildPinyinKeys output (pinyinTokens.test.ts).
const PENG: ColleagueRow = {
  openId: "ou_peng",
  name: "彭爱丽(Aili Peng)",
  email: "aili.peng@fenchem.com",
  department: "Sales",
  pinyinFull: "peng ai li pengaili",
  pinyinInitials: "pal",
  pinyinAlts: "bang",
  nameFold: "彭爱丽(aili peng)",
};
const JASPER: ColleagueRow = {
  openId: "ou_yang",
  name: "杨俊琪(Jasper. Y)",
  email: "jasper.y@fenchem.com",
  department: "APAC",
  pinyinFull: "yang jun qi yangjunqi",
  pinyinInitials: "yjq",
  pinyinAlts: "",
  nameFold: "杨俊琪(jasper. y)",
};
const JAMES: ColleagueRow = {
  openId: "ou_james",
  name: "James Liu",
  email: "james.liu@fenchem.com",
  department: "Sales",
  pinyinFull: "",
  pinyinInitials: "",
  pinyinAlts: "",
  nameFold: "james liu",
};
const SHAN: ColleagueRow = {
  openId: "ou_shan",
  name: "单伟",
  department: "Ops",
  pinyinFull: "shan wei shanwei",
  pinyinInitials: "sw",
  pinyinAlts: "danwei dan chan",
  nameFold: "单伟",
};
const LI: ColleagueRow = {
  openId: "ou_li",
  name: "李明",
  email: "li.ming@fenchem.com",
  department: "Sales",
  pinyinFull: "li ming liming",
  pinyinInitials: "lm",
  pinyinAlts: "",
  nameFold: "李明",
};
const DONG: ColleagueRow = {
  openId: "ou_dong",
  name: "陈冬冬",
  email: "chen.dd@fenchem.com",
  department: "Sales",
  pinyinFull: "chen dong dong chendongdong",
  pinyinInitials: "cdd",
  pinyinAlts: "",
  nameFold: "陈冬冬",
};
const ALL = [PENG, JASPER, JAMES, SHAN, LI, DONG];

const names = (rows: ColleagueRow[]) => rows.map((r) => r.name);

describe("rankColleagues", () => {
  it("returns [] for blank or sub-2-char LATIN queries", () => {
    expect(rankColleagues("", ALL)).toEqual([]);
    expect(rankColleagues(" ", ALL)).toEqual([]);
    expect(rankColleagues("p", ALL)).toEqual([]);
  });

  it("allows a single CJK character and finds it as a substring (冬 -> 陈冬冬)", () => {
    expect(names(rankColleagues("冬", ALL))).toContain("陈冬冬");
    // a contained run also matches
    expect(names(rankColleagues("冬冬", ALL))).toContain("陈冬冬");
    // a leading run prefix-matches (higher tier) and still returns it
    expect(rankColleagues("陈冬", ALL)[0]).toBe(DONG);
    // and the pinyin of a middle syllable finds it too (dong -> 陈冬冬)
    expect(names(rankColleagues("dong", ALL))).toContain("陈冬冬");
  });

  it("ranks an exact glued full-pinyin hit first", () => {
    expect(rankColleagues("pengaili", ALL)[0]).toBe(PENG);
  });

  it("matches Pinyin initials (pal -> 彭爱丽)", () => {
    expect(rankColleagues("pal", ALL)[0]).toBe(PENG);
  });

  it("finds a partial mid-name syllable run via substring (aili -> 彭爱丽)", () => {
    expect(names(rankColleagues("aili", ALL))).toContain("彭爱丽(Aili Peng)");
  });

  it("matches the English alias / email even for a CJK-named colleague (jasper)", () => {
    expect(rankColleagues("jasper", ALL)[0]).toBe(JASPER);
  });

  it("finds a colleague by the non-surname reading stored in alts (danwei -> 单伟)", () => {
    expect(names(rankColleagues("danwei", ALL))).toContain("单伟");
  });

  it("keeps negative precision: a loose substring never outranks a real pinyin hit", () => {
    // "li" is a syllable of 李明 and 彭爱丽 (prefix tier) but only a loose
    // substring of "james liu" — James must rank below the pinyin matches.
    const ranked = names(rankColleagues("li", ALL));
    expect(ranked).toContain("李明");
    expect(ranked.indexOf("James Liu")).toBeGreaterThan(ranked.indexOf("李明"));
  });

  it("ranks an exact name match above everything", () => {
    expect(rankColleagues("james liu", ALL)[0]).toBe(JAMES);
  });

  it("floats the preferred department within a score tie", () => {
    // Both names PREFIX-match "bravo" (same tier) without equalling it, so the
    // tie-break decides. "Bravo Alpha" sorts before "Bravo Beta" by name, but
    // the Sales row must float to the top under preferredDepartment.
    const tieRows: ColleagueRow[] = [
      { ...JASPER, department: "APAC", name: "Bravo Alpha", nameFold: "bravo alpha", pinyinFull: "", pinyinInitials: "", pinyinAlts: "", email: undefined },
      { ...LI, department: "Sales", name: "Bravo Beta", nameFold: "bravo beta", pinyinFull: "", pinyinInitials: "", pinyinAlts: "", email: undefined },
    ];
    const ranked = rankColleagues("bravo", tieRows, { preferredDepartment: "Sales" });
    expect(ranked[0]?.department).toBe("Sales");
    // and without the preference, name-asc wins (Alpha first)
    expect(rankColleagues("bravo", tieRows)[0]?.name).toBe("Bravo Alpha");
  });

  it("honors the limit", () => {
    expect(rankColleagues("fenchem.com", ALL, { limit: 2 })).toHaveLength(2);
  });
});

describe("foldQuery", () => {
  it("folds full-width and lowercases (matches server foldName)", () => {
    expect(foldQuery("  ＰＡＬ ")).toBe("pal");
  });
});
