import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useCoworkerSearch } from "./useCoworkerSearch";
import type { ColleagueRow } from "../components/taskpane/colleagueRank";

// The hook is now thin glue over the preloaded directory + the pure ranker
// (ranking itself is exhaustively tested in colleagueRank.test.ts). Mock the
// directory so these tests assert the glue: the short-query guard, that it ranks
// the preloaded rows, and that it returns slim Coworkers (no avatarUrl).
vi.mock("./useColleagueDirectory", () => ({ useColleagueDirectory: vi.fn() }));
import { useColleagueDirectory } from "./useColleagueDirectory";
const mockUseColleagueDirectory = vi.mocked(useColleagueDirectory);

const ROWS: ColleagueRow[] = [
  {
    openId: "ou_peng",
    name: "彭爱丽(Aili Peng)",
    email: "aili.peng@fenchem.com",
    department: "Sales",
    pinyinFull: "peng ai li pengaili",
    pinyinInitials: "pal",
    pinyinAlts: "",
    nameFold: "彭爱丽(aili peng)",
  },
  {
    openId: "ou_james",
    name: "James Liu",
    department: "Sales",
    pinyinFull: "",
    pinyinInitials: "",
    pinyinAlts: "",
    nameFold: "james liu",
  },
];

describe("useCoworkerSearch (preload-backed)", () => {
  beforeEach(() => {
    mockUseColleagueDirectory.mockReturnValue({
      state: { status: "ready", contacts: ROWS, mirroredAt: 1 },
      refresh: vi.fn(),
    });
  });

  it("returns [] for a too-short Latin query", () => {
    const { result } = renderHook(() => useCoworkerSearch("session"));
    expect(result.current("a")).toEqual([]);
  });

  it("ranks the preloaded directory by Pinyin initials and returns slim Coworkers (no avatarUrl)", () => {
    const { result } = renderHook(() => useCoworkerSearch("session"));
    expect(result.current("pal")).toEqual([{ openId: "ou_peng", name: "彭爱丽(Aili Peng)" }]);
  });

  it("matches by glued full Pinyin and by Latin name substring", () => {
    const { result } = renderHook(() => useCoworkerSearch("session"));
    expect(result.current("pengaili")[0]?.name).toBe("彭爱丽(Aili Peng)");
    expect(result.current("james")[0]?.name).toBe("James Liu");
  });

  it("finds a colleague by a single CJK character (爱 -> 彭爱丽)", () => {
    const { result } = renderHook(() => useCoworkerSearch("session"));
    expect(result.current("爱").map((c) => c.name)).toContain("彭爱丽(Aili Peng)");
  });

  it("preloads nothing when logged out (empty sessionId still safe)", () => {
    mockUseColleagueDirectory.mockReturnValue({
      state: { status: "idle", contacts: [], mirroredAt: null },
      refresh: vi.fn(),
    });
    const { result } = renderHook(() => useCoworkerSearch(""));
    expect(result.current("pal")).toEqual([]);
  });
});
