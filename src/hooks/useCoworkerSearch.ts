// Colleague picker search (ADR-0024). Rewritten from the live-Feishu-per-
// keystroke + manual LRU model: the whole directory (<=800, often <30) is
// preloaded once (useColleagueDirectory) and every keystroke ranks it IN MEMORY
// via the pure rankColleagues matcher — zero network, zero Convex, no cache, no
// cross-border tail. Matching is synchronous; the Promise return shape is kept
// only so CoworkerPicker.tsx (which awaits search(q)) is untouched.
//
// Latency tracing: from China the backend RTT is ~150-350ms, so a per-keystroke
// server call could never be fast; a local scan should be sub-millisecond. We
// log every search's duration and warn past a 20ms budget so a regression (or a
// directory that outgrows the preload) is visible on the DebugPanel.

import { useCallback } from "react";

import { dlog, dtime } from "../debug";
import {
  rankColleagues,
  type ColleagueRow,
} from "../components/taskpane/colleagueRank";
import type { Coworker } from "../components/taskpane/coworkers";
import { useColleagueDirectory } from "./useColleagueDirectory";

// "20ms below is good" — the budget for the in-memory scan. Exceeding it on a
// <=800-row directory means something regressed (or the directory grew).
const SEARCH_LATENCY_BUDGET_MS = 20;

// Session-scoped running max, surfaced in the slow-search log so you can see the
// worst keystroke without reading every line.
let sessionMaxMs = 0;

function toCoworker(row: ColleagueRow): Coworker {
  // avatarUrl is volatile (ADR-0003); CoworkerOption falls back to the icon if it
  // 404s. Included so the search dropdown shows real photos (ADR-0024 revision).
  return { openId: row.openId, name: row.name, avatarUrl: row.avatarUrl };
}

// Real Feishu directory search, now served from the preloaded mirror (ADR-0024;
// ADR-0023 for the mirror). sessionId gates the preload on login; the second
// arg (formerly the Feishu user token) is no longer used. Returns [] for a
// blank/too-short query (rankColleagues allows single CJK chars).
export function useCoworkerSearch(sessionId: string, _userAccessToken?: string) {
  const isLoggedIn = sessionId.trim() !== "";
  const { state } = useColleagueDirectory(isLoggedIn);
  const rows = state.contacts;

  return useCallback(
    (query: string): Promise<Coworker[]> => {
      const started = performance.now();
      const found = rankColleagues(query, rows);
      const elapsed = dtime(
        `coworker search "${query.slice(0, 24)}" -> ${found.length}/${rows.length}`,
        started,
      );
      if (elapsed > sessionMaxMs) sessionMaxMs = elapsed;
      if (elapsed > SEARCH_LATENCY_BUDGET_MS) {
        dlog(
          `coworker search SLOW: ${Math.round(elapsed)}ms > ${SEARCH_LATENCY_BUDGET_MS}ms budget ` +
            `(rows=${rows.length}, sessionMax=${Math.round(sessionMaxMs)}ms)`,
        );
      }
      return Promise.resolve(found.map((row) => toCoworker(row)));
    },
    [rows],
  );
}
