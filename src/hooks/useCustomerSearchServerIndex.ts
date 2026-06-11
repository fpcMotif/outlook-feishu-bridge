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

// The Customer Mirror full sync is intentionally heavy: it pages Feishu Bitable
// records/search under documented API limits, then updates Convex's search
// read model. Opening/closing the picker repeatedly should not enqueue several
// full syncs; cache-miss backfill still covers fresh rows between kicks.
const MIRROR_KICK_COOLDOWN_MS = 15 * 60 * 1000;
// Round-trip saver only — the engine's MIN_CUSTOMER_SEARCH_LENGTH is the
// authoritative copy of this rule and backstops any drift here.
const MIN_SERVER_SEARCH_LENGTH = 2;
const EMPTY_LIVE_MISS_TTL_MS = 30 * 1000;
// Negative cache for domain auto-match misses. A domain Feishu itself reported
// empty stays "known absent" for this long so re-opening mails from the same
// (often personal) sender does not re-query Feishu per conversation. Longer
// than the typed-search TTL because the absence of a whole Customer domain
// changes far more rarely than search-result relevance.
const EMPTY_DOMAIN_MATCH_TTL_MS = 5 * 60 * 1000;
let lastMirrorKickStartedAt = 0;
const inFlightSearches = new Map<string, Promise<CustomerRecord[]>>();
const inFlightEmailMatches = new Map<string, Promise<CustomerRecord | null>>();
const emptyLiveMisses = new Map<string, number>();
const emptyDomainMatchMisses = new Map<string, number>();

type ConvexClient = ReturnType<typeof useConvex>;
type SearchAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.searchCustomers>>;
type KickAction = ReturnType<typeof useAction<typeof api.feishu.customersMirror.kick>>;
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
// suppresses re-asking a question the live leg just answered "empty" (a query
// proven empty 30s ago is not re-paid — the brief staleness window is the
// price of not hammering the cross-border live search per keystroke).
async function runServerSearch(
  searchCustomers: SearchAction,
  key: string,
  q: string,
  mineFor: string | undefined,
): Promise<CustomerRecord[]> {
  const started = performance.now();
  if (hasRecentEmptyLiveMiss(key)) {
    dtime(`customer search (recent empty live miss) "${q.slice(0, 40)}" -> 0`, started);
    return [];
  }
  const result = await searchCustomers(searchArgs(q, mineFor));
  if (result.source === "live") rememberLiveMiss(key, result.records);
  else emptyLiveMisses.delete(key);
  dtime(
    `customer search (${result.source}${result.source === "live" ? ` + backfill ${result.backfilled}` : ""}) "${q.slice(0, 40)}" -> ${result.records.length}`,
    started,
  );
  return result.records;
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
  const convex: ConvexClient = useConvex();
  const kickAction = useAction(api.feishu.customersMirror.kick);
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
      return trackSearch(key, runServerSearch(searchCustomersAction, key, q, options?.mineFor));
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

  const triggerRefresh = useCallback(() => {
    kickMirror(kickAction);
  }, [kickAction]);

  return { directory: EMPTY_DIRECTORY, search, matchEmail, triggerRefresh };
}
