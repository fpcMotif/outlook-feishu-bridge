// ADR-0013 preload path of Customer search. The Customer Directory is fetched
// once on login (useCustomerDirectory), local Array.filter answers most
// queries, and a per-keystroke server fallback covers cache misses. This is the
// path selected when VITE_CUSTOMER_SEARCH_MODE !== "server-index".

import { useCallback } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";
import {
  findCustomerByEmail,
  type CustomerRecord,
  type CustomerSearchOptions,
} from "../components/taskpane/customers";
import { dtime } from "../debug";
import { useCustomerDirectory } from "./useCustomerDirectory";
import type { CustomerSearch } from "./customerSearch";

const MIN_SERVER_SEARCH_LENGTH = 2;

const inFlightPreloadSearches = new Map<string, Promise<CustomerRecord[]>>();

function preloadSearchKey(q: string): string {
  return q.toLowerCase();
}

function trackPreloadSearch(key: string, p: Promise<CustomerRecord[]>): Promise<CustomerRecord[]> {
  inFlightPreloadSearches.set(key, p);
  p.then(
    () => inFlightPreloadSearches.delete(key),
    () => inFlightPreloadSearches.delete(key),
  );
  return p;
}

function filterByOwner(
  records: readonly CustomerRecord[],
  mineFor: string | undefined,
): CustomerRecord[] {
  return mineFor === undefined
    ? [...records]
    : records.filter((record) => record.owner?.openId === mineFor);
}

export function useCustomerSearchPreload(isLoggedIn: boolean): CustomerSearch {
  const directoryHook = useCustomerDirectory(isLoggedIn);
  const legacyAction = useAction(api.feishu.customers.searchCustomers);

  const search = useCallback(
    (query: string, options?: CustomerSearchOptions): Promise<CustomerRecord[]> => {
      const q = query.trim();
      if (q.length < MIN_SERVER_SEARCH_LENGTH) return Promise.resolve([]);
      const key = preloadSearchKey(q);
      const inFlight = inFlightPreloadSearches.get(key);
      const started = performance.now();
      const rawRecords = inFlight ?? trackPreloadSearch(
        key,
        legacyAction({ query: q }).then(({ records }) => {
          dtime(`customer search (server) "${q.slice(0, 40)}" -> ${records.length}`, started);
          return records;
        }),
      );
      return rawRecords.then((records) => filterByOwner(records, options?.mineFor));
    },
    [legacyAction],
  );

  const matchEmail = useCallback(
    (email: string): Promise<CustomerRecord | null> =>
      Promise.resolve(
        email.trim() ? findCustomerByEmail(directoryHook.state.records, email) : null,
      ),
    [directoryHook.state.records],
  );

  const triggerRefresh = useCallback(() => {
    directoryHook.refresh();
  }, [directoryHook]);

  return { directory: directoryHook.state, search, matchEmail, triggerRefresh };
}
