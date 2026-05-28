// Customer Directory preload (ADR-0013). When the user logs in we fire the
// tenant-token listCustomers action once and cache the projection in a
// module-level singleton so multiple consumers share one fetch. The hook is
// non-blocking: callers receive `{ status: "loading", records: [] }` while the
// fetch is in flight, and the CustomerPicker degrades to a "Resolving…" state.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";
import type {
  CustomerDirectoryState,
  CustomerRecord,
} from "../components/taskpane/customers";
import { dlog, dtime } from "../debug";

// Singleton — survives component remounts within a session. Re-set to "idle"
// on logout via {@link resetCustomerDirectory}.
let cache: CustomerDirectoryState = { status: "idle", records: [] };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: CustomerDirectoryState) {
  cache = next;
  for (const fn of listeners) fn();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CustomerDirectoryState {
  return cache;
}

export function resetCustomerDirectory() {
  inflight = null;
  publish({ status: "idle", records: [] });
}

export interface UseCustomerDirectory {
  state: CustomerDirectoryState;
  /** Force-refresh the directory from Bitable. Fire-and-forget; safe to call
   *  multiple times — concurrent calls dedupe via `inflight`. */
  refresh: () => void;
}

/* eslint-disable max-lines-per-function */
export function useCustomerDirectory(isLoggedIn: boolean): UseCustomerDirectory {
  const list = useAction(api.feishu.customers.listCustomers);
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Bumping this nonce forces the effect below to re-run and re-fetch.
  // Used by `refresh()` so a "user opened the search panel" event can trigger
  // an explicit re-read of the Customer Table (ADR-0016: refresh on user
  // trigger, not only on the weekly cron).
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (cache.status === "loading") return;
    if (inflight) return;
    // First pass: skip if the cache is already ready. Subsequent refresh()
    // bumps move the nonce so this effect re-runs and falls through to fetch.
    if (cache.status === "ready" && refreshNonce === 0) return;
    publish({ status: "loading", records: cache.records });
    dlog(
      `customer directory: preload ${refreshNonce === 0 ? "starting" : "refreshing"} (nonce=${refreshNonce})`,
    );
    const started = performance.now();
    inflight = list({})
      .then((res: { records: CustomerRecord[] }) => {
        const elapsed = dtime(
          `customer directory: preload ready (${res.records.length} rows)`,
          started,
        );
        if (elapsed > 1500) dlog(`customer directory: preload SLOW (${Math.round(elapsed)}ms > 1500ms budget)`);
        publish({ status: "ready", records: res.records });
      })
      .catch((e: unknown) => {
        dtime(`customer directory: preload FAILED — ${e instanceof Error ? e.message : String(e)}`, started);
        publish({ status: "error", records: cache.records });
      })
      .finally(() => {
        inflight = null;
      });
  }, [isLoggedIn, list, refreshNonce]);

  const refresh = useCallback(() => {
    // Already refreshing → leave the in-flight call alone; it'll publish soon.
    if (inflight) return;
    setRefreshNonce((n) => n + 1);
  }, []);

  return { state, refresh };
}
