// Composite hook the RequestIntakeScreen depends on: bundles the Customer
// Directory preload (ADR-0013) and server-side Customer search behind one
// interface so a single vi.mock replaces both in tests.

import type { CustomerSearch } from "./customerSearch";
import { useCustomerSearchPreload } from "./useCustomerSearchPreload";
import { useCustomerSearchServerIndex } from "./useCustomerSearchServerIndex";

// ADR-0016: build-time flag selects the data layer.
//   "preload"      -> ADR-0013 path: useCustomerDirectory + local Array.filter
//   "server-index" -> ADR-0016 path: ranked Convex query against the mirror
const SEARCH_MODE: "preload" | "server-index" =
  import.meta.env.VITE_CUSTOMER_SEARCH_MODE === "server-index" ? "server-index" : "preload";

export function useCustomerSearch(isLoggedIn: boolean): CustomerSearch {
  // Conditional hook calls are not allowed, so both focused data hooks are
  // always called; the mode decides which path feeds the picker. Preload is
  // disabled in server-index mode to avoid shipping the CRM directory to the
  // browser while still preserving hook order.
  const preload = useCustomerSearchPreload(SEARCH_MODE === "preload" ? isLoggedIn : false);
  const serverIndex = useCustomerSearchServerIndex();

  return SEARCH_MODE === "server-index" ? serverIndex : preload;
}
