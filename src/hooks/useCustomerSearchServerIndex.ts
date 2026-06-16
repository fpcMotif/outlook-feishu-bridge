// ADR-0016 server-index path of Customer search. The mirror-vs-live strategy
// lives SERVER-SIDE behind one public action (customersMirror.searchCustomers,
// driven by the Customer-search engine): the SPA sends the query and receives
// records + provenance. The domain auto-match follows the same cache-aside
// shape: matchEmail probes the mirror first and only a genuine miss falls
// through to a targeted one-page Feishu domain search (matchEmailAndCacheMiss)
// that backfills the mirror — no user path ever triggers a full-table Mirror
// Refresh (that stays on the weekly cron + the manual kick backstop). This
// hook keeps only TRANSPORT concerns — request coalescing, empty-result
// suppression, and the client-side Mirror Kick cooldown. No directory is
// preloaded — the picker stays interactive against a ready-but-empty directory
// and delegates every keystroke to the server. Selected when
// VITE_CUSTOMER_SEARCH_MODE === "server-index".

import { useCallback } from "react";
import { useAction, useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import { emailDomain, type CustomerDirectoryState, type CustomerRecord, type CustomerSearchOptions } from "../components/taskpane/customers";
import { dlog, dtime } from "../debug";
import type { CustomerSearch } from "./customerSearch";

// No preload in this mode; expose a ready empty directory so the picker stays
// interactive and delegates to server search on every keystroke.
const EMPTY_DIRECTORY: CustomerDirectoryState = { status: "ready", records: [] };

// Round-trip saver only — the engine's MIN_CUSTOMER_SEARCH_LENGTH is the
// authoritative copy of this rule and backstops any drift here.
const MIN_SERVER_SEARCH_LENGTH = 2;
// Debounce typed search calls so rapid keystrokes collapse to one server round-trip.
// 150 ms is imperceptible for deliberate keystrokes but absorbs burst typing on slow
// connections. The engine's in-flight coalescing handles any remaining concurrent
// calls that arrive AFTER the debounce fires.
const SEARCH_DEBOUNCE_MS = 150;
const EMPTY_LIVE_MISS_TTL_MS = 30 * 1000;
// Negative cache for domain auto-match misses. A domain Feishu itself reported
// empty stays "known absent" for this long so re-opening mails from the same
// (often personal) sender does not re-query Feishu per conversation. Longer
// than the typed-search TTL because the absence of a whole Customer domain
// changes far more rarely than search-result relevance.
const EMPTY_DOMAIN_MATCH_TTL_MS = 5 * 60 * 1000;
const inFlightSearches = new Map<string, Promise<CustomerRecord[]>>();
const pendingDebounces = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; resolvers: Array<(r: CustomerRecord[]) => void> }
>();
const inFlightEmailMatches = new Map<string, Promise<CustomerRecord | null>>();
const emptyLiveMisses = new Map<string, number>();
const emptyDomainMatchMisses = new Map<string, number>();

type ConvexClient = ReturnType<typeof useConvex>;
type SearchAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.searchCustomers>>;
type MatchEmailAction = ReturnType<
  typeof useAction<typeof api.feishu.customersMirror.matchEmailAndCacheMiss>
>;

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

function trackEmailMatch(key: string, p: Promise<CustomerRecord | null>): Promise<CustomerRecord | null> {
  inFlightEmailMatches.set(key, p);
  p.then(
    () => inFlightEmailMatches.delete(key),
    () => inFlightEmailMatches.delete(key),
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

function rememberLiveMiss(key: string, records: readonly CustomerRecord[]) {
  if (records.length === 0) emptyLiveMisses.set(key, Date.now());
  else emptyLiveMisses.delete(key);
}

function hasRecentEmptyDomainMatch(domain: string): boolean {
  const cachedAt = emptyDomainMatchMisses.get(domain);
  if (cachedAt === undefined) return false;
  if (Date.now() - cachedAt < EMPTY_DOMAIN_MATCH_TTL_MS) return true;
  emptyDomainMatchMisses.delete(domain);
  return false;
}

function rememberDomainMatchMiss(domain: string, customer: CustomerRecord | null) {
  if (customer === null) emptyDomainMatchMisses.set(domain, Date.now());
  else emptyDomainMatchMisses.delete(domain);
}

// Cache-aside domain auto-match: the Convex mirror answers first; only a true
// mirror miss (and no fresh negative-cache entry) falls through to the targeted
// one-page Feishu domain search, which backfills the mirror and returns the
// match so the caller can select it immediately.
async function runMirrorEmailMatch(
  convex: ConvexClient,
  matchEmailAndCacheMiss: MatchEmailAction,
  email: string,
  domain: string,
): Promise<CustomerRecord | null> {
  const started = performance.now();
  const local = await convex.query(api.feishu.customersMirror.matchByEmail, { email });
  if (local.customer) {
    emptyDomainMatchMisses.delete(domain);
    dtime(`customer match (mirror hit) "${domain}"`, started);
    return local.customer;
  }
  if (hasRecentEmptyDomainMatch(domain)) {
    dtime(`customer match (recent empty live miss) "${domain}" -> null`, started);
    return null;
  }
  const live = await matchEmailAndCacheMiss({ email });
  rememberDomainMatchMiss(domain, live.customer);
  dtime(
    `customer match (mirror miss -> live + backfill ${live.backfilled}) "${domain}" -> ${live.customer ? "hit" : "null"}`,
    started,
  );
  return live.customer;
}

// One server search: the engine decides mirror-vs-live; this side only
// suppresses the live leg when that exact query was proven empty ≤30s ago.
// Rather than returning [] early (which would skip the mirror backfill path),
// we pass liveAllowed:false so the engine still consults the mirror — it may
// have been backfilled by a concurrent matchEmailAndCacheMiss — without
// re-paying the cross-border live search.
async function runServerSearch(
  searchCustomers: SearchAction,
  key: string,
  q: string,
  mineFor: string | undefined,
): Promise<CustomerRecord[]> {
  const started = performance.now();
  const recentMiss = hasRecentEmptyLiveMiss(key);
  const callArgs = recentMiss
    ? { ...searchArgs(q, mineFor), liveAllowed: false as const }
    : searchArgs(q, mineFor);
  const result = await searchCustomers(callArgs);
  if (result.source === "live") rememberLiveMiss(key, result.records);
  else emptyLiveMisses.delete(key);
  dtime(
    `customer search (${result.source}${result.source === "live" ? ` + backfill ${result.backfilled}` : ""}${recentMiss ? " liveAllowed:false" : ""}) "${q.slice(0, 40)}" -> ${result.records.length}`,
    started,
  );
  return result.records;
}

// eslint-disable-next-line max-lines-per-function -- cohesive hook: the coalesced + debounced `search` and `matchEmail` callbacks plus the assembled CustomerSearch return.
export function useCustomerSearchServerIndex(): CustomerSearch {
  const convex: ConvexClient = useConvex();
  const searchCustomersAction = useAction(api.feishu.customersMirror.searchCustomers);
  const matchEmailAndCacheMissAction = useAction(api.feishu.customersMirror.matchEmailAndCacheMiss);

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
      const pending = pendingDebounces.get(key);
      if (pending) clearTimeout(pending.timer);
      return new Promise<CustomerRecord[]>((resolve) => {
        const resolvers = pending ? [...pending.resolvers, resolve] : [resolve];
        const timer = setTimeout(() => {
          pendingDebounces.delete(key);
          void trackSearch(
            key,
            runServerSearch(searchCustomersAction, key, q, options?.mineFor),
          ).then((records) => {
            resolvers.forEach((r) => r(records));
          });
        }, SEARCH_DEBOUNCE_MS);
        pendingDebounces.set(key, { timer, resolvers });
      });
    },
    [searchCustomersAction],
  );

  const matchEmail = useCallback(
    (email: string): Promise<CustomerRecord | null> => {
      const domain = emailDomain(email);
      if (!domain) return Promise.resolve(null);
      const inFlight = inFlightEmailMatches.get(domain);
      if (inFlight) return inFlight;
      return trackEmailMatch(
        domain,
        runMirrorEmailMatch(convex, matchEmailAndCacheMissAction, email, domain),
      );
    },
    [convex, matchEmailAndCacheMissAction],
  );

  // Mirror Refresh is cron-managed only (weekly). The on-demand kick was removed
  // because the server-side cooldown already throttles it and the UX gain was
  // marginal — cache-miss backfill via matchEmailAndCacheMiss covers the
  // common "new customer, open mail" case without a full re-sync.
  const triggerRefresh = useCallback(() => {}, []);

  return { directory: EMPTY_DIRECTORY, search, matchEmail, triggerRefresh };
}
