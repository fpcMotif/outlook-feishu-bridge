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
import { dlog, dtime } from "../debug";
import type { CustomerSearch } from "./customerSearch";

// No preload in this mode; expose a ready empty directory so the picker stays
// interactive and delegates to server search on every keystroke.
const EMPTY_DIRECTORY: CustomerDirectoryState = { status: "ready", records: [] };

// The Customer Mirror full sync is intentionally heavy: it pages Feishu Bitable
// records/search under documented API limits, then updates Convex's search
// read model. Opening/closing the picker repeatedly should not enqueue several
// full syncs; cache-miss backfill still covers fresh rows between kicks.
const MIRROR_KICK_COOLDOWN_MS = 15 * 60 * 1000;
const MIN_SERVER_SEARCH_LENGTH = 2;
const EMPTY_LIVE_MISS_TTL_MS = 30 * 1000;
let lastMirrorKickStartedAt = 0;
const inFlightSearches = new Map<string, Promise<CustomerRecord[]>>();
const emptyLiveMisses = new Map<string, number>();

type ConvexClient = ReturnType<typeof useConvex>;
type SearchAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.searchAndCacheMiss>>;
type KickAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.kick>>;

function searchArgs(q: string, mineFor: string | undefined) {
  return mineFor === undefined ? { q } : { q, mineFor };
}

function searchKey(q: string, mineFor: string | undefined): string {
  return `${mineFor ?? "<all>"}:${q.toLowerCase()}`;
}

function trackSearch(key: string, p: Promise<CustomerRecord[]>): Promise<CustomerRecord[]> {
  inFlightSearches.set(key, p);
  p.then(
    () => inFlightSearches.delete(key),
    () => inFlightSearches.delete(key),
  );
  return p;
}

function hasRecentEmptyLiveMiss(key: string): boolean {
  const cachedAt = emptyLiveMisses.get(key);
  if (cachedAt === undefined) return false;
  if (Date.now() - cachedAt < EMPTY_LIVE_MISS_TTL_MS) return true;
  emptyLiveMisses.delete(key);
  return false;
}

function rememberLiveMiss(key: string, records: CustomerRecord[]) {
  if (records.length === 0) emptyLiveMisses.set(key, Date.now());
  else emptyLiveMisses.delete(key);
}

async function runMirrorSearch(
  convex: ConvexClient,
  searchAndCacheMiss: SearchAction,
  key: string,
  q: string,
  mineFor: string | undefined,
): Promise<CustomerRecord[]> {
  const started = performance.now();
  const args = searchArgs(q, mineFor);
  const hit = await convex.query(api.feishu.customersMirror.search, args);
  if (hit.records.length > 0) {
    emptyLiveMisses.delete(key);
    dtime(`customer search (mirror hit) "${q.slice(0, 40)}" -> ${hit.records.length}`, started);
    return hit.records;
  }
  if (hasRecentEmptyLiveMiss(key)) {
    dtime(`customer search (recent empty live miss) "${q.slice(0, 40)}" -> 0`, started);
    return [];
  }
  const live = await searchAndCacheMiss(args);
  rememberLiveMiss(key, live.records);
  dtime(
    `customer search (mirror miss -> live + backfill ${live.backfilled}) "${q.slice(0, 40)}" -> ${live.records.length}`,
    started,
  );
  return live.records;
}

function kickMirror(kickAction: KickAction) {
  const now = Date.now();
  if (lastMirrorKickStartedAt > 0 && now - lastMirrorKickStartedAt < MIRROR_KICK_COOLDOWN_MS) {
    dlog("customer mirror: on-search kick skipped (cooldown)");
    return;
  }
  lastMirrorKickStartedAt = now;
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
      if (q.length < MIN_SERVER_SEARCH_LENGTH) return Promise.resolve([]);
      const key = searchKey(q, options?.mineFor);
      const inFlight = inFlightSearches.get(key);
      if (inFlight) {
        dlog(`customer search coalesced "${q.slice(0, 40)}"`);
        return inFlight;
      }
      return trackSearch(key, runMirrorSearch(convex, searchAndCacheMissAction, key, q, options?.mineFor));
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
