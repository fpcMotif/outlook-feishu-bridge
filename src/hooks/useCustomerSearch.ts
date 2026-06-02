// Composite hook the RequestIntakeScreen depends on: bundles the Customer
// Directory preload (ADR-0013) and server-side Customer search behind one
// interface so a single vi.mock replaces both in tests.

import type { CustomerSearch } from "./customerSearch";
import type { CustomerRecord } from "../components/taskpane/customers";
import { useCustomerSearchPreload } from "./useCustomerSearchPreload";
import { useCustomerSearchServerIndex } from "./useCustomerSearchServerIndex";

// ADR-0016: build-time flag selects the data layer.
//   "preload"      -> ADR-0013 path: useCustomerDirectory + local Array.filter
//   "server-index" -> ADR-0016 path: ranked Convex query against the mirror
const SEARCH_MODE: "preload" | "server-index" =
  import.meta.env.VITE_CUSTOMER_SEARCH_MODE === "server-index" ? "server-index" : "preload";

// Deterministic dev/e2e fixture customer (parallels CoworkerPicker's
// PREVIEW_COWORKERS, ADR-0003). It matches the dev sample sender domain so the
// submit gate (ADR-0020 requires a customer) can reach the ready state without
// depending on the live Customer mirror. Only reachable in dev preview.
const PREVIEW_CUSTOMER: CustomerRecord = {
  recordId: "dev_fixture_bayer_customer",
  name: "Bayer Pharma (preview)",
  domain: "bayerpharma.de",
  owner: null,
};

const PREVIEW_CUSTOMER_SEARCH: CustomerSearch = {
  directory: { status: "ready", records: [PREVIEW_CUSTOMER] },
  search: () => Promise.resolve([]),
  matchEmail: (email) =>
    Promise.resolve(email.toLowerCase().endsWith("@bayerpharma.de") ? PREVIEW_CUSTOMER : null),
  triggerRefresh: () => {},
};

export function useCustomerSearch(isLoggedIn: boolean, usePreviewCustomers = false): CustomerSearch {
  // Conditional hook calls are not allowed, so both focused data hooks are
  // always called; the mode decides which path feeds the picker. Preload is
  // disabled in server-index/preview mode to avoid shipping the CRM directory to
  // the browser while still preserving hook order.
  const preload = useCustomerSearchPreload(
    SEARCH_MODE === "preload" && !usePreviewCustomers ? isLoggedIn : false,
  );
  const serverIndex = useCustomerSearchServerIndex();

  if (usePreviewCustomers) return PREVIEW_CUSTOMER_SEARCH;
  return SEARCH_MODE === "server-index" ? serverIndex : preload;
}
