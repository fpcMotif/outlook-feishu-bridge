// Customer Directory preload (ADR-0013). When the user logs in we fire the
// tenant-token listCustomers action once and cache the projection in a
// module-level singleton so multiple consumers share one fetch. The hook is
// non-blocking: callers receive `{ status: "loading", records: [] }` while the
// fetch is in flight, and the CustomerPicker degrades to a "Resolving…" state.

import { useEffect, useState } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";
import type {
  CustomerDirectoryState,
  CustomerRecord,
} from "../components/taskpane/customers";

// Singleton — survives component remounts within a session. Re-set to "idle"
// on logout via {@link resetCustomerDirectory}.
let cache: CustomerDirectoryState = { status: "idle", records: [] };
let inflight: Promise<void> | null = null;
const listeners = new Set<(state: CustomerDirectoryState) => void>();

function publish(next: CustomerDirectoryState) {
  cache = next;
  for (const fn of listeners) fn(next);
}

export function resetCustomerDirectory() {
  inflight = null;
  publish({ status: "idle", records: [] });
}

export function useCustomerDirectory(isLoggedIn: boolean): CustomerDirectoryState {
  const list = useAction(api.feishu.customers.listCustomers);
  const [state, setState] = useState<CustomerDirectoryState>(cache);

  useEffect(() => {
    const sub = (next: CustomerDirectoryState) => setState(next);
    listeners.add(sub);
    setState(cache);
    return () => {
      listeners.delete(sub);
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn) return;
    if (cache.status === "ready" || cache.status === "loading") return;
    if (inflight) return;
    publish({ status: "loading", records: [] });
    inflight = list({})
      .then((res: { records: CustomerRecord[] }) => {
        publish({ status: "ready", records: res.records });
      })
      .catch(() => {
        publish({ status: "error", records: [] });
      })
      .finally(() => {
        inflight = null;
      });
  }, [isLoggedIn, list]);

  return state;
}
