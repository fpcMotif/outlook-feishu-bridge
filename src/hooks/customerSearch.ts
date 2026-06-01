// Shared shape returned by the two focused Customer-search hooks
// (useCustomerSearchPreload — ADR-0013, useCustomerSearchServerIndex —
// ADR-0016). The call site selects one path via the build-time mode flag in
// useCustomerSearch.ts; both return this identical interface so CustomerPicker
// and the tests that mock useCustomerSearch are unaffected.

import type {
  CustomerDirectoryState,
  CustomerRecord,
  CustomerSearchOptions,
} from "../components/taskpane/customers";

export interface CustomerSearch {
  directory: CustomerDirectoryState;
  search: (query: string, options?: CustomerSearchOptions) => Promise<CustomerRecord[]>;
  matchEmail: (email: string) => Promise<CustomerRecord | null>;
  /** Fire a fresh sync (preload re-fetch or mirror kick) without blocking the caller. */
  triggerRefresh: () => void;
}
