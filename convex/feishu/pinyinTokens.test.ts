import { describe, expect, it } from "vitest";

import { buildPinyinKeys, foldName } from "./pinyinTokens";

// Golden values are the VERIFIED output of pinyin-pro 3.28 (toneType:'none',
// surname:'head', pattern via first-letter, per-char multiple:true). They pin
// the option choices so a library/dictionary regression fails CI loudly.
describe("buildPinyinKeys", () => {
  it("projects a plain Han name to spaced + glued full and initials", () => {
    const k = buildPinyinKeys("彭爱丽");
    expect(k.full).toBe("peng ai li pengaili");
    expect(k.initials).toBe("pal");
    // alts only ever carries NON-canonical readings (rare polyphones are fine).
    for (const canonical of ["peng", "ai", "li"]) expect(k.alts).not.toContain(canonical);
  });

  it("ignores the Latin alias and only pinyin-izes the Han run", () => {
    // The "(Aili Peng)" / "(Jasper. Y)" parts are handled by nameFold, never pinyin.
    const peng = buildPinyinKeys("彭爱丽(Aili Peng)");
    expect(peng.full).toBe("peng ai li pengaili");
    expect(peng.initials).toBe("pal");
    const yang = buildPinyinKeys("杨俊琪(Jasper. Y)");
    expect(yang.full).toBe("yang jun qi yangjunqi");
    expect(yang.initials).toBe("yjq");
  });

  it("returns empty keys for a pure-Latin name (degrades to name/email match)", () => {
    expect(buildPinyinKeys("James Liu")).toEqual({ full: "", initials: "", alts: "" });
    expect(buildPinyinKeys("")).toEqual({ full: "", initials: "", alts: "" });
  });

  it("reads the head char as a SURNAME and indexes the non-surname reading as an alt", () => {
    // 单 surname = shan; common reading dan -> in alts (glued "danwei" + "dan"/"chan").
    const dan = buildPinyinKeys("单伟");
    expect(dan.full).toBe("shan wei shanwei");
    expect(dan.initials).toBe("sw");
    expect(dan.alts.split(" ")).toEqual(expect.arrayContaining(["danwei", "dan", "chan"]));
    expect(dan.alts).not.toContain("shan"); // canonical reading excluded from alts
  });

  it("handles a polyphonic surname (乐 -> yue) and keeps the everyday reading findable", () => {
    const le = buildPinyinKeys("乐瑶");
    expect(le.full).toBe("yue yao yueyao");
    expect(le.initials).toBe("yy");
    // everyday "le" reading + glued "leyao" remain matchable via alts
    expect(le.alts.split(" ")).toEqual(expect.arrayContaining(["leyao", "le"]));
  });
});

describe("foldName", () => {
  it("lowercases and trims", () => {
    expect(foldName("  James LIU ")).toBe("james liu");
  });

  it("folds full-width Latin/digits to half-width via NFKC", () => {
    expect(foldName("ＡＢＣ１２３")).toBe("abc123");
  });

  it("preserves Han characters", () => {
    expect(foldName("彭爱丽(Aili Peng)")).toBe("彭爱丽(aili peng)");
  });
});
