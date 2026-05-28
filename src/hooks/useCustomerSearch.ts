// Composite hook the RequestIntakeScreen depends on: bundles the
// Customer Directory preload (ADR-0013) and the per-keystroke server-side
// fallback (`searchCustomers`) behind one interface so a single vi.mock
// replaces both in tests. Mirrors the useCoworkerSearch wrapping pattern.

import { useCallback } from "react";
import { useAction } from "convex/react";

import { api } from "../../convex/_generated/api";
import type {
  CustomerDirectoryState,
  CustomerRecord,
} from "../components/taskpane/customers";
import { useCustomerDirectory } from "./useCustomerDirectory";

export interface CustomerSearch {
  directory: CustomerDirectoryState;
  search: (query: string) => Promise<CustomerRecord[]>;
}

export function useCustomerSearch(isLoggedIn: boolean): CustomerSearch {
  const directory = useCustomerDirectory(isLoggedIn);
  const action = useAction(api.feishu.customers.searchCustomers);
  const search = useCallback(
    async (query: string): Promise<CustomerRecord[]> => {
      const q = query.trim();
      if (!q) return [];
      const { records } = await action({ query: q });
      return records;
    },
    [action],
  );
  return { directory, search };
}
