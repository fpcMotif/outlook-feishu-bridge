import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import type { Coworker, CoworkerDirectoryState } from "../components/taskpane/coworkers";
import { dlog, dtime } from "../debug";

type ConvexClient = ReturnType<typeof useConvex>;

let cache: CoworkerDirectoryState = { status: "idle", records: [] };
let inflight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function publish(next: CoworkerDirectoryState): void {
  cache = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): CoworkerDirectoryState {
  return cache;
}

export function resetCoworkerDirectory(): void {
  inflight = null;
  publish({ status: "idle", records: [] });
}

function startCoworkerDirectoryLoad(convex: ConvexClient, sessionId: string): void {
  publish({ status: "loading", records: cache.records });
  const started = performance.now();
  dlog("coworker directory: preload starting");

  inflight = convex
    .query(api.feishu.coworkers.listCoworkerDirectory, { sessionId })
    .then((res: { records: Coworker[] } | null) => {
      if (!res) {
        dtime("coworker directory: preload unavailable", started);
        publish({ status: "error", records: cache.records });
        return;
      }
      const elapsed = dtime(
        `coworker directory: preload ready (${res.records.length} rows)`,
        started,
      );
      if (elapsed > 1500) {
        dlog(`coworker directory: preload SLOW (${Math.round(elapsed)}ms > 1500ms budget)`);
      }
      publish({ status: "ready", records: res.records });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      dtime(`coworker directory: preload FAILED - ${message}`, started);
      publish({ status: "error", records: cache.records });
    })
    .finally(() => {
      inflight = null;
    });
}

function canQueryCoworkerDirectory(convex: ConvexClient): boolean {
  return typeof (convex as { query?: unknown } | undefined)?.query === "function";
}

export function useCoworkerDirectory(
  sessionId: string,
  enabled = true,
): { state: CoworkerDirectoryState; refresh: () => void } {
  const convex = useConvex();
  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const load = useCallback(() => {
    if (!enabled || !sessionId.trim()) return;
    if (!canQueryCoworkerDirectory(convex)) return;
    if (inflight || cache.status === "loading") return;
    if (cache.status === "ready") return;
    startCoworkerDirectoryLoad(convex, sessionId);
  }, [convex, enabled, sessionId]);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => {
    if (inflight) return;
    publish({ status: "idle", records: cache.records });
    load();
  }, [load]);

  return { state, refresh };
}
