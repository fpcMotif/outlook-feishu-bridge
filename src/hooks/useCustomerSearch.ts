// Composite hook the RequestIntakeScreen depends on: bundles the Customer
// Directory preload (ADR-0013) and server-side Customer search behind one
// interface so a single vi.mock replaces both in tests.

import { useCallback } from "react";
import { useAction, useConvex } from "convex/react";

import { api } from "../../convex/_generated/api";
import {
  findCustomerByEmail,
  type CustomerDirectoryState,
  type CustomerRecord,
  type CustomerSearchOptions,
} from "../components/taskpane/customers";
import { dtime } from "../debug";
import { useCustomerDirectory } from "./useCustomerDirectory";

export interface CustomerSearch {
  directory: CustomerDirectoryState;
  search: (query: string, options?: CustomerSearchOptions) => Promise<CustomerRecord[]>;
  matchEmail: (email: string) => Promise<CustomerRecord | null>;
  /** Fire a fresh sync (preload re-fetch or mirror kick) without blocking the caller. */
  triggerRefresh: () => void;
}

// ADR-0016: build-time flag selects the data layer.
//   "preload"      -> ADR-0013 path: useCustomerDirectory + local Array.filter
//   "server-index" -> ADR-0016 path: ranked Convex query against the mirror
const SEARCH_MODE: "preload" | "server-index" =
  (import.meta.env.VITE_CUSTOMER_SEARCH_MODE as string | undefined) === "server-index"
    ? "server-index"
    : "preload";

function filterByOwner(
  records: readonly CustomerRecord[],
  mineFor: string | undefined,
): CustomerRecord[] {
  return mineFor === undefined
    ? [...records]
    : records.filter((record) => record.owner?.openId === mineFor);
}

/* eslint-disable max-lines-per-function */
export function useCustomerSearch(isLoggedIn: boolean): CustomerSearch {
  // Conditional hook calls are not allowed, so both data hooks are always
  // called; the mode decides which path feeds the picker.
  const directoryHook = useCustomerDirectory(SEARCH_MODE === "preload" ? isLoggedIn : false);
  const legacyAction = useAction(api.feishu.customers.searchCustomers);
  const kickAction = useAction(api.feishu.customersMirror.kick);
  const searchAndCacheMissAction = useAction(api.feishu.customersMirror.searchAndCacheMiss);
  const convex = useConvex();

  const search = useCallback(
    async (query: string, options?: CustomerSearchOptions): Promise<CustomerRecord[]> => {
      const q = query.trim();
      if (!q) return [];
      const started = performance.now();
      const mineFor = options?.mineFor;
      if (SEARCH_MODE === "server-index") {
        const result = await convex.query(
          api.feishu.customersMirror.search,
          mineFor === undefined ? { q } : { q, mineFor },
        );
        if (result.records.length > 0) {
          dtime(
            `customer search (mirror hit) "${q.slice(0, 40)}" -> ${result.records.length}`,
            started,
          );
          return result.records;
        }
        const live = await searchAndCacheMissAction(
          mineFor === undefined ? { q } : { q, mineFor },
        );
        dtime(
          `customer search (mirror miss -> live + backfill ${live.backfilled}) "${q.slice(0, 40)}" -> ${live.records.length}`,
          started,
        );
        return live.records;
      }
      const { records } = await legacyAction({ query: q });
      const visibleRecords = filterByOwner(records, mineFor);
      dtime(
        `customer search (server) "${q.slice(0, 40)}" -> ${visibleRecords.length}`,
        started,
      );
      return visibleRecords;
    },
    [convex, legacyAction, searchAndCacheMissAction],
  );

  // Mode-aware refresh: preload mode re-fetches the directory; server-index
  // mode kicks the mirror so the search index is fresh on the next ranked query.
  const matchEmail = useCallback(
    async (email: string): Promise<CustomerRecord | null> => {
      if (!email.trim()) return null;
      if (SEARCH_MODE === "server-index") {
        const result = await convex.query(api.feishu.customersMirror.matchByEmail, { email });
        return result.customer;
      }
      return findCustomerByEmail(directoryHook.state.records, email);
    },
    [convex, directoryHook.state.records],
  );

  const triggerRefresh = useCallback(() => {
    if (SEARCH_MODE === "server-index") {
      const started = performance.now();
      void kickAction({})
        .then((res) => {
          dtime(
            `customer mirror: on-search kick ok pages=${res.pages} rows=${res.rows}`,
            started,
          );
        })
        .catch((error: unknown) => {
          dtime(
            `customer mirror: on-search kick FAILED - ${error instanceof Error ? error.message : String(error)}`,
            started,
          );
        });
      return;
    }
    directoryHook.refresh();
  }, [directoryHook, kickAction]);

  // In server-index mode no directory is preloaded; expose a ready empty
  // directory so the picker stays interactive and delegates to server search.
  const exposedDirectory: CustomerDirectoryState =
    SEARCH_MODE === "server-index" ? { status: "ready", records: [] } : directoryHook.state;

  return { directory: exposedDirectory, search, matchEmail, triggerRefresh };
}
