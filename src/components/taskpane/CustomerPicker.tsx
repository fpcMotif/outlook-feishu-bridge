// The Customer Picker card on the contacts screen (ADR-0013). The parent owns
// `selectedCustomer` and computes the initial auto-match via
// findCustomerByEmail; this module displays the chosen Customer and owns the
// search-panel interaction for manual overrides.

/* eslint-disable max-lines, max-lines-per-function */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, UserRound } from "lucide-react";

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
import { TaskpaneSearchDropdown } from "./TaskpaneSearchDropdown";

const MIN_SERVER_SEARCH_LENGTH = 2;
const LOCAL_MATCH_DISPLAY_LIMIT = 8;

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
  onCreateCustomer?: (name: string) => void;
}

export function CustomerPicker({
  directory,
  emailDomain,
  selectedCustomer,
  currentUserOpenId,
  embedded = false,
  onChange,
  onCreateCustomer,
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

  if (searchSession) {
    return (
      <SearchPanel
        directory={directory}
        searchCustomers={searchCustomers}
        openedAt={searchSession.openedAt}
        currentUserOpenId={currentUserOpenId}
        embedded={embedded}
        onSelect={(customer) => {
          onChange(customer);
          setSearchSession(null);
        }}
        onCreateCustomer={onCreateCustomer}
      />
    );
  }

  return (
    <section className={embedded ? "" : "bg-card-soft rounded-xl shadow-edge"}>
      <div className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2" data-customer-row="true">
        <span
          className="text-muted-foreground flex size-8 shrink-0 items-center justify-center"
          aria-hidden="true"
        >
          <UserRound className="size-4" />
        </span>
        {selectedCustomer ? (
          <>
            <span className="min-w-0 flex-1 whitespace-normal break-words text-xs leading-4 font-semibold">
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
          <span className="text-muted-foreground min-w-0 flex-1 whitespace-normal break-words text-xs leading-4">
            Resolving customer for {emailDomain}...
          </span>
        ) : (
          <NoMatch onSearch={openSearch} />
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
  onSelect,
  onCreateCustomer,
}: {
  directory: CustomerDirectoryState;
  searchCustomers: (
    query: string,
    options?: CustomerSearchOptions,
  ) => Promise<CustomerRecord[]>;
  openedAt: number;
  currentUserOpenId?: string;
  embedded?: boolean;
  onSelect: (customer: CustomerRecord) => void;
  onCreateCustomer?: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverMatches, setServerMatches] = useState<CustomerRecord[]>([]);
  const [showMine, setShowMine] = useState(false);
  const latestSearch = useRef(0);
  const searchTimer = useRef<number | null>(null);
  const q = normalizedQuery(query);

  const localMatches = useMemo<CustomerRecord[]>(() => {
    return filterLocalCustomers(
      directory.records,
      q,
      showMine,
      currentUserOpenId,
      LOCAL_MATCH_DISPLAY_LIMIT,
    );
  }, [q, showMine, currentUserOpenId, directory.records]);

  useEffect(() => {
    return () => {
      if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    };
  }, []);

  const runServerSearch = (nextQuery: string, nextShowMine: boolean) => {
    const nextQ = normalizedQuery(nextQuery);
    if (searchTimer.current !== null) window.clearTimeout(searchTimer.current);
    if (!nextQ || nextQ.length < MIN_SERVER_SEARCH_LENGTH) {
      latestSearch.current += 1;
      setServerMatches([]);
      return;
    }
    const nextLocalMatches = logLocalFilter(
      directory.records,
      nextQ,
      nextShowMine,
      currentUserOpenId,
      LOCAL_MATCH_DISPLAY_LIMIT,
    );
    if (directory.status === "ready" && nextLocalMatches.length > 0) {
      latestSearch.current += 1;
      setServerMatches([]);
      return;
    }
    const searchId = latestSearch.current + 1;
    latestSearch.current = searchId;
    searchTimer.current = window.setTimeout(() => {
      void searchCustomers(nextQ, ownerFilter(nextShowMine, currentUserOpenId))
        .then((rows) => {
          if (latestSearch.current === searchId) setServerMatches(rows);
        })
        .catch(() => {
          if (latestSearch.current === searchId) setServerMatches([]);
        });
    }, 250);
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
  const canOfferCreateCustomer = q.length >= MIN_SERVER_SEARCH_LENGTH;
  const dropdownOpen = Boolean(showMine || matches.length > 0 || canOfferCreateCustomer);

  return (
    <section className={embedded ? "px-3 py-2" : "bg-card-soft rounded-xl px-3 py-2 shadow-edge"}>
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
        </div>
      </div>
      <TaskpaneSearchDropdown
        label="Search customers"
        value={query}
        onChange={handleQueryChange}
        placeholder="Search by name, domain, account no..."
        open={dropdownOpen}
        listLabel="Customer results"
        emptyMessage={`No customers match "${query}"`}
      >
        {matches.length > 0
          ? matches.map((customer) => (
            <button
              key={customer.recordId}
              type="button"
              data-search-option=""
              aria-selected={false}
              onClick={() => {
                dtime(`customer picker: picked "${customer.name}"`, openedAt);
                onSelect(customer);
              }}
              className="bg-card hover:bg-accent aria-selected:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs shadow-edge"
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
            ))
          : canOfferCreateCustomer ? (
            <button
              type="button"
              data-search-option=""
              aria-selected={false}
              onClick={() => {
                dtime(`customer picker: create requested "${q}"`, openedAt);
                onCreateCustomer?.(query.trim());
              }}
              className="bg-card hover:bg-accent aria-selected:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold shadow-edge"
            >
              <Plus className="text-primary size-4 shrink-0" />
              <span className="min-w-0 flex-1 truncate">Create customer task "{query.trim()}"</span>
            </button>
            )
          : null}
      </TaskpaneSearchDropdown>
    </section>
  );
}

// Lenient no-match (ADR-0013): tell the salesperson the auto-match found
// nothing and reserve a placeholder for the future create-new affordance, but
// do not block the sync. A search icon button lets them override manually.
function NoMatch({ onSearch }: { onSearch: () => void }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span
        className="text-muted-foreground min-w-0 flex-1 whitespace-normal break-words text-xs leading-4"
        title="No matched"
      >
        No matched
      </span>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search customer"
        className="text-primary hover:bg-accent inline-flex size-10 shrink-0 items-center justify-center rounded-full transition-colors active:scale-[0.96]"
      >
        <Search className="size-4" />
      </button>
      <button
        type="button"
        disabled
        aria-label="Add new customer (coming soon)"
        className="text-muted-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-full opacity-40"
      >
        <Plus className="size-4" />
      </button>
    </span>
  );
}
