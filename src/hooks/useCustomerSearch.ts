// Composite hook the RequestIntakeScreen depends on: bundles the
// Customer Directory preload (ADR-0013) and the per-keystroke server-side
// fallback (`searchCustomers`) behind one interface so a single vi.mock
// replaces both in tests. Mirrors the useCoworkerSearch wrapping pattern.

import { useCallback } from "react";
import { useAction, useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import type {
  CustomerDirectoryState,
  CustomerRecord,
} from "../components/taskpane/customers";
import { dtime } from "../debug";
import { useCustomerDirectory } from "./useCustomerDirectory";

export interface CustomerSearch {
  directory: CustomerDirectoryState;
  search: (query: string) => Promise<CustomerRecord[]>;
  /** Fire a fresh sync (preload re-fetch or mirror kick) without blocking the
   *  caller. ADR-0016: called when the user opens the Customer search panel
   *  so we get freshness on the moment-of-care, not just on the weekly cron. */
  triggerRefresh: () => void;
}

// ADR-0016: build-time flag selects the data layer.
//   "preload"      → ADR-0013 path: useCustomerDirectory + local Array.filter
//                     (default, current production behaviour)
//   "server-index" → ADR-0016 path: no preload; per-keystroke ranked Convex
//                     query against the mirrored `customers` table.
const SEARCH_MODE: "preload" | "server-index" =
  (import.meta.env.VITE_CUSTOMER_SEARCH_MODE as string | undefined) === "server-index"
    ? "server-index"
    : "preload";

/* eslint-disable max-lines-per-function */
export function useCustomerSearch(isLoggedIn: boolean): CustomerSearch {
  // Conditional hook calls aren't allowed, so we ALWAYS call both data hooks;
  // the mode just decides which path's results feed the picker.
  const directoryHook = useCustomerDirectory(SEARCH_MODE === "preload" ? isLoggedIn : false);
  const legacyAction = useAction(api.feishu.customers.searchCustomers);
  const kickAction = useAction(api.feishu.customersMirror.kick);
  const convex = useConvex();

  const searchAndCacheMissAction = useAction(api.feishu.customersMirror.searchAndCacheMiss);
  const search = useCallback(
    async (query: string): Promise<CustomerRecord[]> => {
      const q = query.trim();
      if (!q) return [];
      const started = performance.now();
      if (SEARCH_MODE === "server-index") {
        // ADR-0016 cache-aside: (1) try the fast Convex search index. (2) if
        // 0 hits, fall through to a live Feishu search via the action; the
        // action upserts any new rows back into the mirror, so the next
        // query for the same term will hit cache.
        const result = await convex.query(api.feishu.customersMirror.search, { q });
        if (result.records.length > 0) {
          dtime(
            `customer search (mirror hit) "${q.slice(0, 40)}" → ${result.records.length}`,
            started,
          );
          return result.records;
        }
        const live = await searchAndCacheMissAction({ q });
        dtime(
          `customer search (mirror miss → live + backfill ${live.backfilled}) "${q.slice(0, 40)}" → ${live.records.length}`,
          started,
        );
        return live.records;
      }
      const { records } = await legacyAction({ query: q });
      dtime(`customer search (server) "${q.slice(0, 40)}" → ${records.length}`, started);
      return records;
    },
    [convex, legacyAction, searchAndCacheMissAction],
  );

  // Mode-aware refresh: in preload mode we re-fetch the directory; in
  // server-index mode we kick the mirror so the search index is fresh on the
  // next ranked query. Both fire-and-forget — the SearchPanel doesn't wait.
  const triggerRefresh = useCallback(() => {
    if (SEARCH_MODE === "server-index") {
      const started = performance.now();
      kickAction({})
        .then((res) => {
          dtime(
            `customer mirror: on-search kick ok pages=${res.pages} rows=${res.rows}`,
            started,
          );
        })
        .catch((e: unknown) => {
          dtime(
            `customer mirror: on-search kick FAILED — ${e instanceof Error ? e.message : String(e)}`,
            started,
          );
        });
      return;
    }
    directoryHook.refresh();
  }, [directoryHook, kickAction]);

  // In server-index mode the directory state is irrelevant; expose a synthetic
  // "ready, empty records" so the picker's "loading" / "no match" branches
  // behave correctly (we never preload anything in this mode).
  const exposedDirectory: CustomerDirectoryState =
    SEARCH_MODE === "server-index" ? { status: "ready", records: [] } : directoryHook.state;

  return { directory: exposedDirectory, search, triggerRefresh };
}
