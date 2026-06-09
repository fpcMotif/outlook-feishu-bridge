// Pure Pinyin projection for the Feishu Contacts Mirror / colleague picker
// (ADR-0024). Runs ONLY on the sync (server) side, so pinyin-pro's dictionary
// never reaches the SPA bundle. No ctx, no I/O -> unit-testable with plain
// vitest (the extract-then-test seam, ADR-0019). Sibling of cjkSearch.ts.
//
// The match keys are precomputed once per biweekly sync and stored on the
// feishuContacts row; the client matcher (colleagueRank.ts) does plain string
// matching over them, so the per-keystroke path ships and runs zero pinyin code.
//
// pinyin-pro option choices are NOT arbitrary -- each was verified against the
// live library (3.28) and the official docs (https://pinyin-pro.cn), and is
// pinned by the golden tests in pinyinTokens.test.ts:
//  - surname:'head'  -> the head char reads as a SURNAME (单->shan, 曾->zeng,
//    乐->yue), but medial chars keep their normal reading. 'all' would mis-read
//    medial chars.
//  - pattern:'first' -> first letter PER SYLLABLE (彭爱丽->"p a l"). 'initial'
//    returns 声母 clusters (gaps for vowel-initial syllables, zh/ch/sh -> 2).
//  - multiple:true works PER CHARACTER only, so polyphones are enumerated char
//    by char (单 -> dan|shan|chan) and unioned into `alts`.

import { pinyin } from "pinyin-pro";

import { IS_CJK_CHAR } from "./cjkSearch";

export interface PinyinKeys {
  /** Spaced + glued surname-correct reading, e.g. "peng ai li pengaili". */
  full: string;
  /** First letter per syllable, e.g. "pal". */
  initials: string;
  /** Alternate readings (non-surname glued + per-char polyphones), space-joined. */
  alts: string;
}

const EMPTY_KEYS: PinyinKeys = { full: "", initials: "", alts: "" };

/** The Han characters of a name, in order; Latin/punctuation/spaces dropped. */
function hanOnly(name: string): string {
  let out = "";
  for (const ch of name) {
    if (IS_CJK_CHAR.test(ch)) out += ch;
  }
  return out;
}

/** Toneless syllable array; surname:'head' reads only the leading surname char. */
function syllableArray(text: string, useSurname: boolean): string[] {
  const result = useSurname
    ? pinyin(text, { toneType: "none", type: "array", surname: "head" })
    : pinyin(text, { toneType: "none", type: "array" });
  return (result as string[]).map((syllable) => syllable.toLowerCase());
}

/** Every toneless reading of a single Han character (polyphones included). */
function readingsOf(char: string): string[] {
  const result = pinyin(char, { toneType: "none", multiple: true, type: "array" });
  return (result as string[]).map((reading) => reading.toLowerCase());
}

/**
 * Project a (possibly mixed CN/EN) name into Pinyin match keys. Returns empty
 * keys when the name holds no Han characters (e.g. "James Liu") so the caller
 * cleanly omits the optional fields and the matcher falls back to name/email.
 */
export function buildPinyinKeys(name: string): PinyinKeys {
  const han = hanOnly(name);
  if (han === "") return EMPTY_KEYS;

  const surnameSyllables = syllableArray(han, true);
  const spaced = surnameSyllables.join(" ");
  const glued = surnameSyllables.join("");
  const full = glued ? `${spaced} ${glued}` : spaced;
  const initials = surnameSyllables.map((syllable) => syllable[0] ?? "").join("");

  const canonical = new Set(surnameSyllables);
  const alts = new Set<string>();
  // Non-surname glued reading (e.g. 单伟 -> "danwei") for users who type the
  // common, non-surname pronunciation.
  const plainGlued = syllableArray(han, false).join("");
  if (plainGlued && plainGlued !== glued) alts.add(plainGlued);
  // Per-character polyphone syllables not already in the canonical reading.
  for (const char of han) {
    for (const reading of readingsOf(char)) {
      if (reading && !canonical.has(reading)) alts.add(reading);
    }
  }

  return { full, initials, alts: [...alts].join(" ") };
}

/**
 * Canonical fold for plain (non-pinyin) substring matching: NFKC (collapses
 * full-width Latin/digits to half-width), trimmed, lowercased. Used for the
 * `nameFold` column and to normalize the query the same way client-side.
 */
export function foldName(name: string): string {
  return name.normalize("NFKC").trim().toLowerCase();
}
