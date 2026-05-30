// ADR-0016 server-index path of Customer search. Ranked queries hit the
// Convex-held Customer Mirror; a mirror miss falls back to a live search with
// cache-miss backfill, and opening the picker kicks a Mirror Refresh so the
// index is fresh on the next query. No directory is preloaded — the picker
// stays interactive against a ready-but-empty directory and delegates every
// keystroke to the server. Selected when VITE_CUSTOMER_SEARCH_MODE ===
// "server-index".

import { useCallback } from "react";
import { useAction, useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import type {
  CustomerDirectoryState,
  CustomerRecord,
  CustomerSearchOptions,
} from "../components/taskpane/customers";
import { dtime } from "../debug";
import type { CustomerSearch } from "./customerSearch";

// No preload in this mode; expose a ready empty directory so the picker stays
// interactive and delegates to server search on every keystroke.
const EMPTY_DIRECTORY: CustomerDirectoryState = { status: "ready", records: [] };

type ConvexClient = ReturnType<typeof useConvex>;
type SearchAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.searchAndCacheMiss>>;
type KickAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.kick>>;

function searchArgs(q: string, mineFor: string | undefined) {
  return mineFor === undefined ? { q } : { q, mineFor };
}

async function runMirrorSearch(
  convex: ConvexClient,
  searchAndCacheMiss: SearchAction,
  q: string,
  mineFor: string | undefined,
): Promise<CustomerRecord[]> {
  const started = performance.now();
  const args = searchArgs(q, mineFor);
  const hit = await convex.query(api.feishu.customersMirror.search, args);
  if (hit.records.length > 0) {
    dtime(`customer search (mirror hit) "${q.slice(0, 40)}" -> ${hit.records.length}`, started);
    return hit.records;
  }
  const live = await searchAndCacheMiss(args);
  dtime(
    `customer search (mirror miss -> live + backfill ${live.backfilled}) "${q.slice(0, 40)}" -> ${live.records.length}`,
    started,
  );
  return live.records;
}

function kickMirror(kickAction: KickAction) {
  const started = performance.now();
  void kickAction({})
    .then((res) => {
      dtime(`customer mirror: on-search kick ok pages=${res.pages} rows=${res.rows}`, started);
    })
    .catch((error: unknown) => {
      dtime(
        `customer mirror: on-search kick FAILED - ${error instanceof Error ? error.message : String(error)}`,
        started,
      );
    });
}

export function useCustomerSearchServerIndex(): CustomerSearch {
  const convex = useConvex();
  const kickAction = useAction(api.feishu.customersMirror.kick);
  const searchAndCacheMissAction = useAction(api.feishu.customersMirror.searchAndCacheMiss);

  const search = useCallback(
    (query: string, options?: CustomerSearchOptions): Promise<CustomerRecord[]> => {
      const q = query.trim();
      if (!q) return Promise.resolve([]);
      return runMirrorSearch(convex, searchAndCacheMissAction, q, options?.mineFor);
    },
    [convex, searchAndCacheMissAction],
  );

  const matchEmail = useCallback(
    async (email: string): Promise<CustomerRecord | null> => {
      if (!email.trim()) return null;
      const result = await convex.query(api.feishu.customersMirror.matchByEmail, { email });
      return result.customer;
    },
    [convex],
  );

  const triggerRefresh = useCallback(() => {
    kickMirror(kickAction);
  }, [kickAction]);

  return { directory: EMPTY_DIRECTORY, search, matchEmail, triggerRefresh };
}
