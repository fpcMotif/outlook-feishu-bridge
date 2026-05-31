import { useCallback } from "react";
import { dlog, dtime } from "../debug";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Coworker } from "../components/taskpane/coworkers";

interface CoworkerCacheEntry {
  ts: number;
  value: Coworker[];
}

const COWORKER_SEARCH_CACHE_TTL_MS = 5 * 60 * 1000;
const COWORKER_SEARCH_CACHE_MAX_ENTRIES = 24;

const cache = new Map<string, CoworkerCacheEntry>();
const inflight = new Map<string, Promise<Coworker[]>>();

function normalizeQuery(query: string): string {
  return query.trim();
}

function tokenFingerprint(token: string | undefined): string {
  if (token === undefined) return "convex-session";
  let hash = 2166136261;
  for (const char of token) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 16777619);
  }
  return `fallback-${Math.abs(Math.trunc(hash)).toString(36)}`;
}

function cacheKey(sessionId: string, query: string, userAccessToken?: string): string {
  const normalizedSession = sessionId.trim() || "<guest>";
  return `${normalizedSession}:${tokenFingerprint(userAccessToken)}:${query.toLowerCase()}`;
}

function pruneExpiredCaches(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.ts > COWORKER_SEARCH_CACHE_TTL_MS) {
      cache.delete(key);
    }
  }
}

function getCached(
  sessionId: string,
  query: string,
  userAccessToken?: string,
): Coworker[] | undefined {
  pruneExpiredCaches(Date.now());
  const key = cacheKey(sessionId, query, userAccessToken);
  const hit = cache.get(key);
  if (!hit) return undefined;

  // touch for LRU-like behavior (Map keeps insertion order)
  cache.delete(key);
  cache.set(key, hit);
  return hit.value;
}

function setCached(
  sessionId: string,
  query: string,
  value: Coworker[],
  userAccessToken?: string,
): void {
  pruneExpiredCaches(Date.now());
  const key = cacheKey(sessionId, query, userAccessToken);
  cache.set(key, { ts: Date.now(), value });
  if (cache.size <= COWORKER_SEARCH_CACHE_MAX_ENTRIES) return;
  const first = cache.keys().next().value;
  if (first !== undefined) {
    cache.delete(first);
  }
}

// Real Feishu directory search (Search Users, scope contact:user:search, user
// token). The sessionId scopes the user token. See convex/feishu/coworkers.ts +
// ADR-0003. Returns [] for a blank query.
//
// Added in-session query cache and in-flight de-dup to avoid duplicate API calls
// while users type, reopen the picker, or rapidly repeat the same query.
export function useCoworkerSearch(sessionId: string, userAccessToken?: string) {
  const searchAction = useAction(api.feishu.coworkers.searchCoworkers);
  return useCallback(
    (query: string): Promise<Coworker[]> => {
      const q = normalizeQuery(query);
      if (!q) return Promise.resolve([]);

      const key = cacheKey(sessionId, q, userAccessToken);
      const cached = getCached(sessionId, q, userAccessToken);
      if (cached) {
        dlog(`coworker search cache hit "${q.slice(0, 40)}" (${cached.length})`);
        return Promise.resolve(cached);
      }

      const inFlight = inflight.get(key);
      if (inFlight) {
        dlog(`coworker search coalesced "${q.slice(0, 40)}"`);
        return inFlight;
      }

      const started = performance.now();
      const p = searchAction({ sessionId, query: q, userAccessToken })
        .then((result) => {
          setCached(sessionId, q, result, userAccessToken);
          dtime(`coworker search network (Feishu) "${q.slice(0, 40)}" -> ${result.length}`, started);
          dlog(`coworker search cached "${q.slice(0, 40)}" -> ${result.length}`);
          return result;
        })
        .catch((error: unknown) => {
          dtime(`coworker search failed "${q.slice(0, 40)}"`, started);
          throw error;
        });
      inflight.set(key, p);
      p.then(
        () => {
          inflight.delete(key);
        },
        () => {
          inflight.delete(key);
        },
      );

      return p;
    },
    [searchAction, sessionId, userAccessToken],
  );
}
