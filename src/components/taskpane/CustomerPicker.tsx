// The Customer Picker card on the contacts screen (ADR-0013). The parent owns
// `selectedCustomer` and computes the initial auto-match via
// findCustomerByEmail; this module displays the chosen Customer and owns the
// search-panel interaction for manual overrides.

/* eslint-disable max-lines-per-function */
import { useMemo, useRef, useState } from "react";
import { Plus, X } from "lucide-react";

import type {
  CustomerDirectoryState,
  CustomerRecord,
  CustomerSearchOptions,
} from "./customers";
import {
  filterLocalCustomers,
  logLocalFilter,
  normalizedQuery,
  ownerFilter,
} from "./customerSearchHelpers";
import { dlog, dtime } from "../../debug";
import { TaskpaneSearchField } from "./TaskpaneSearchField";

export interface CustomerPickerProps {
  directory: CustomerDirectoryState;
  searchCustomers: (
    query: string,
    options?: CustomerSearchOptions,
  ) => Promise<CustomerRecord[]>;
  /** Optional fire-and-forget refresh: opening the picker triggers freshness. */
  triggerRefresh?: () => void;
  emailDomain: string;
  selectedCustomer: CustomerRecord | null;
  // The signed-in Feishu user's open_id (the Initiator, ADR-0014). When
  // provided, the search panel offers a "Show mine" quick toggle.
  currentUserOpenId?: string;
  embedded?: boolean;
  onChange: (customer: CustomerRecord | null) => void;
}

export function CustomerPicker({
  directory,
  emailDomain,
  selectedCustomer,
  currentUserOpenId,
  embedded = false,
  onChange,
  searchCustomers,
  triggerRefresh,
}: CustomerPickerProps) {
  const [searchSession, setSearchSession] = useState<{ openedAt: number } | null>(null);

  const openSearch = () => {
    const openedAt = performance.now();
    dlog(
      `customer picker: search opened (directory ${directory.status}, ${directory.records.length} rows)`,
    );
    triggerRefresh?.();
    setSearchSession({ openedAt });
  };

  const closeSearch = () => {
    if (searchSession) dtime("customer picker: search closed", searchSession.openedAt);
    setSearchSession(null);
  };

  if (searchSession) {
    return (
      <SearchPanel
        directory={directory}
        searchCustomers={searchCustomers}
        openedAt={searchSession.openedAt}
        currentUserOpenId={currentUserOpenId}
        embedded={embedded}
        onCancel={closeSearch}
        onSelect={(customer) => {
          onChange(customer);
          setSearchSession(null);
        }}
      />
    );
  }

  return (
    <section className={embedded ? "" : "bg-card-soft rounded-xl shadow-[var(--shadow-border)]"}>
      <div className="flex h-14 min-w-0 items-center gap-2 px-3" data-customer-row="true">
        <span className="text-muted-foreground shrink-0 text-[11px] font-semibold uppercase">
          Customer
        </span>
        <span className="bg-border h-3 w-px shrink-0" />
        {selectedCustomer ? (
          <>
            <span className="min-w-0 flex-1 truncate text-xs font-semibold">
              {selectedCustomer.name}
            </span>
            <button
              type="button"
              onClick={openSearch}
              className="text-primary inline-flex min-h-8 items-center rounded-md px-2 text-[11px] font-semibold"
            >
              Change
            </button>
          </>
        ) : directory.status === "loading" || directory.status === "idle" ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            Resolving customer for {emailDomain}...
          </span>
        ) : (
          <NoMatch emailDomain={emailDomain} onSearch={openSearch} />
        )}
      </div>
    </section>
  );
}

// Search panel: typing filters the in-memory Customer Directory by a substring
// match across name, fullName, accountNo, domain, and owner.name. If the local
// directory cannot answer, it asks the server search adapter.
function SearchPanel({
  directory,
  searchCustomers,
  openedAt,
  currentUserOpenId,
  embedded = false,
  onCancel,
  onSelect,
}: {
  directory: CustomerDirectoryState;
  searchCustomers: (
    query: string,
    options?: CustomerSearchOptions,
  ) => Promise<CustomerRecord[]>;
  openedAt: number;
  currentUserOpenId?: string;
  embedded?: boolean;
  onCancel: () => void;
  onSelect: (customer: CustomerRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverMatches, setServerMatches] = useState<CustomerRecord[]>([]);
  const [showMine, setShowMine] = useState(false);
  const latestSearch = useRef(0);
  const q = normalizedQuery(query);

  const localMatches = useMemo<CustomerRecord[]>(() => {
    return filterLocalCustomers(directory.records, q, showMine, currentUserOpenId);
  }, [q, showMine, currentUserOpenId, directory.records]);

  const runServerSearch = (nextQuery: string, nextShowMine: boolean) => {
    const nextQ = normalizedQuery(nextQuery);
    const nextLocalMatches = logLocalFilter(
      directory.records,
      nextQ,
      nextShowMine,
      currentUserOpenId,
    );
    if (!nextQ || (directory.status === "ready" && nextLocalMatches.length > 0)) {
      latestSearch.current += 1;
      setServerMatches([]);
      return;
    }
    const searchId = latestSearch.current + 1;
    latestSearch.current = searchId;
    void searchCustomers(nextQ, ownerFilter(nextShowMine, currentUserOpenId))
      .then((rows) => {
        if (latestSearch.current === searchId) setServerMatches(rows);
      })
      .catch(() => {
        if (latestSearch.current === searchId) setServerMatches([]);
      });
  };

  const handleQueryChange = (nextQuery: string) => {
    setQuery(nextQuery);
    runServerSearch(nextQuery, showMine);
  };

  const handleShowMine = () => {
    const nextShowMine = !showMine;
    setShowMine(nextShowMine);
    runServerSearch(query, nextShowMine);
  };

  const matches = localMatches.length > 0 ? localMatches : serverMatches;

  return (
    <section className={embedded ? "px-3 py-2" : "bg-card-soft rounded-xl px-3 py-2 shadow-[var(--shadow-border)]"}>
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-muted-foreground text-[11px] font-semibold uppercase">
          Pick a customer
        </span>
        <div className="flex items-center gap-1">
          {currentUserOpenId ? (
            <button
              type="button"
              aria-pressed={showMine}
              onClick={handleShowMine}
              className="data-[on=true]:bg-accent data-[on=true]:text-accent-foreground text-muted-foreground inline-flex min-h-8 items-center rounded-md px-2 text-[11px] font-semibold"
              data-on={showMine}
            >
              Show mine
            </button>
          ) : null}
          <button
            type="button"
            onClick={onCancel}
            aria-label="Cancel"
            className="text-muted-foreground inline-flex min-h-8 items-center gap-1 rounded-md px-1 text-[11px] font-semibold"
          >
            <X className="size-3.5" />
            Cancel
          </button>
        </div>
      </div>
      <TaskpaneSearchField
        label="Search customers"
        value={query}
        onChange={handleQueryChange}
        placeholder="Search by name, domain, account no..."
      />
      <ul className="mt-2 space-y-1">
        {matches.slice(0, 8).map((customer) => (
          <li key={customer.recordId}>
            <button
              type="button"
              onClick={() => {
                dtime(`customer picker: picked "${customer.name}"`, openedAt);
                onSelect(customer);
              }}
              className="bg-card hover:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs shadow-[var(--shadow-border)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{customer.name}</span>
                {customer.domain || customer.countryRegion || customer.owner ? (
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {[
                      customer.domain,
                      customer.countryRegion,
                      customer.owner ? `owned by ${customer.owner.name}` : null,
                    ]
                      .filter(Boolean)
                      .join(" / ")}
                  </span>
                ) : null}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

// Lenient no-match (ADR-0013): tell the salesperson the auto-match found
// nothing and reserve a placeholder for the future create-new affordance, but
// do not block the sync. A Search button lets them override manually.
function NoMatch({ emailDomain, onSearch }: { emailDomain: string; onSearch: () => void }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-2">
      <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
        No customer matched for {emailDomain}
      </span>
      <button
        type="button"
        onClick={onSearch}
        className="text-primary inline-flex min-h-8 items-center rounded-md px-2 text-[11px] font-semibold"
      >
        Search
      </button>
      <button
        type="button"
        disabled
        aria-label="Add new customer (coming soon)"
        className="text-muted-foreground inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold opacity-50"
      >
        <Plus className="size-3.5" />
        Add new customer
      </button>
    </span>
  );
}
