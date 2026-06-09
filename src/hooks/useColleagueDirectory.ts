// Colleague Directory preload (ADR-0024). When the user logs in we fire the
// `listForPicker` query ONCE and cache the slim projection in a module-level
// singleton so every consumer shares one fetch. Deliberately a ONE-SHOT
// `convex.query` (not a reactive `useQuery`): the directory changes only on the
// biweekly contacts-mirror sync, so a standing subscription would re-push the
// whole payload on every sync write for no benefit — the repo's own precedent
// (useCustomerDirectory) is one-shot too. Refresh on a user trigger via the
// nonce instead. Non-blocking: callers get `{ status: "loading", contacts: [] }`
// while in flight.

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { ColleagueRow } from "../components/taskpane/colleagueRank";
import { dlog, dtime } from "../debug";

export interface ColleagueDirectoryState {
  status: "idle" | "loading" | "ready" | "error";
  contacts: ColleagueRow[];
  /** Watermark: when the mirror last fully synced (null until first sync). */
  mirroredAt: number | null;
}

// Singleton — survives component remounts within a session; reset on logout.
let cache: ColleagueDirectoryState = { status: "idle", contacts: [], mirroredAt: null };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: ColleagueDirectoryState) {
  cache = next;
  for (const fn of listeners) fn();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): ColleagueDirectoryState {
  return cache;
}

export function resetColleagueDirectory() {
  inflight = null;
  publish({ status: "idle", contacts: [], mirroredAt: null });
}

export interface UseColleagueDirectory {
  state: ColleagueDirectoryState;
  /** Force-refresh from the mirror. Fire-and-forget; concurrent calls dedupe. */
  refresh: () => void;
}

/* eslint-disable max-lines-per-function */
export function useColleagueDirectory(isLoggedIn: boolean): UseColleagueDirectory {
  const convex = useConvex();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  // Bumping this nonce re-runs the effect for an explicit refresh() (e.g. the
  // search panel opened) without a standing subscription.
  const [refreshNonce, setRefreshNonce] = useState(0);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (cache.status === "loading") return;
    if (inflight) return;
    if (cache.status === "ready" && refreshNonce === 0) return;
    publish({ status: "loading", contacts: cache.contacts, mirroredAt: cache.mirroredAt });
    dlog(
      `colleague directory: preload ${refreshNonce === 0 ? "starting" : "refreshing"} (nonce=${refreshNonce})`,
    );
    const started = performance.now();
    inflight = convex
      .query(api.feishu.contactsMirror.listForPicker, {})
      .then((res) => {
        const contacts = res.contacts as ColleagueRow[];
        const elapsed = dtime(`colleague directory: preload ready (${contacts.length} rows)`, started);
        if (elapsed > 1500) {
          dlog(`colleague directory: preload SLOW (${Math.round(elapsed)}ms > 1500ms budget)`);
        }
        publish({ status: "ready", contacts, mirroredAt: res.mirroredAt });
      })
      .catch((e: unknown) => {
        dtime(
          `colleague directory: preload FAILED — ${e instanceof Error ? e.message : String(e)}`,
          started,
        );
        publish({ status: "error", contacts: cache.contacts, mirroredAt: cache.mirroredAt });
      })
      .finally(() => {
        inflight = null;
      });
  }, [isLoggedIn, convex, refreshNonce]);

  const refresh = useCallback(() => {
    if (inflight) return;
    setRefreshNonce((n) => n + 1);
  }, []);

  return { state, refresh };
}
