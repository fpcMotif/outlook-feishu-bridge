// The Customer Picker card on the contacts screen (ADR-0013). The parent owns
// `selectedCustomer` and computes the initial auto-match via
// findCustomerByEmail; this module displays the chosen Customer and owns the
// search-panel interaction for manual overrides.

/* eslint-disable max-lines-per-function, max-lines -- two cohesive panels (selected + search) for one picker. */
import { useMemo, useRef, useState, type RefObject } from "react";
import { Plus, UserRound } from "lucide-react";

import type {
  CustomerDirectoryState,
  CustomerRecord,
  CustomerSearchOptions,
} from "./customers";
import {
  customerSearchEmptyMessage,
  filterLocalCustomers,
  getCustomerSearchEmptyKind,
  logLocalFilter,
  normalizedQuery,
  ownerFilter,
} from "./customerSearchHelpers";
import { CustomerSearchEmptyState } from "./CustomerSearchEmptyState";
import { dlog, dtime } from "../../debug";
import {
  TaskpaneSearchDropdown,
  TaskpaneSelectionRow,
} from "@/design-system/taskpane";
import { TaskpanePickerPanel } from "./TaskpanePickerPanel";
import {
  TASKPANE_SEARCH_PANEL_SHELL,
  TASKPANE_SEARCH_PANEL_SHELL_HEADER,
} from "./taskpaneSearchPanelLayout";
import { useCustomerSearchSession } from "./useCustomerSearchSession";

export interface CustomerPickerProps {
  directory: CustomerDirectoryState;
  searchCustomers: (
    query: string,
    options?: CustomerSearchOptions,
  ) => Promise<CustomerRecord[]>;
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
  selectedCustomer,
  currentUserOpenId,
  embedded = false,
  onChange,
  onCreateCustomer,
  searchCustomers,
}: CustomerPickerProps) {
  const session = useCustomerSearchSession();
  const defaultOpenedAt = useRef<number | null>(null);
  if (defaultOpenedAt.current === null)
    defaultOpenedAt.current = performance.now();

  // Opening the picker is purely local — no Mirror Kick. Freshness comes from
  // the typed-search cache-miss backfill once the user actually queries.
  const openSearch = () => {
    dlog(
      `customer picker: search opened (directory ${directory.status}, ${directory.records.length} rows)`,
    );
    session.openSearch();
  };

  if (!selectedCustomer || session.searchSession) {
    return (
      <SearchPanel
        directory={directory}
        searchCustomers={searchCustomers}
        openedAt={session.searchSession?.openedAt ?? defaultOpenedAt.current}
        currentUserOpenId={currentUserOpenId}
        embedded={embedded}
        exiting={session.exiting}
        boundaryRef={
          session.searchSession ? session.searchPanelBoundaryRef : undefined
        }
        onDismiss={session.searchSession ? session.dismissSearch : undefined}
        onSelect={(customer) => {
          onChange(customer);
          session.closeSearch();
        }}
        onCreateCustomer={onCreateCustomer}
      />
    );
  }

  return (
    <SelectedCustomerPanel
      customer={selectedCustomer}
      embedded={embedded}
      onChange={openSearch}
    />
  );
}

function SelectedCustomerPanel({
  customer,
  embedded,
  onChange,
}: {
  customer: CustomerRecord;
  embedded: boolean;
  onChange: () => void;
}) {
  const shell = embedded
    ? TASKPANE_SEARCH_PANEL_SHELL_HEADER
    : TASKPANE_SEARCH_PANEL_SHELL;

  return (
    <TaskpanePickerPanel
      as="section"
      title="customer"
      srTitle="Customer"
      titleId="customer-picker-title"
      shellClassName={shell}
      className={embedded ? undefined : "bg-card-soft rounded-xl shadow-edge"}
    >
      <TaskpaneSelectionRow
        dataRow="customer"
        icon={<UserRound className="size-4" />}
        label={customer.name}
        inset={false}
        onChange={onChange}
      />
    </TaskpanePickerPanel>
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
  exiting = false,
  boundaryRef,
  onDismiss,
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
  exiting?: boolean;
  boundaryRef?: RefObject<HTMLElement | null>;
  onDismiss?: () => void;
  onSelect: (customer: CustomerRecord) => void;
  onCreateCustomer?: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverMatches, setServerMatches] = useState<CustomerRecord[]>([]);
  const [showMine, setShowMine] = useState(false);
  const latestSearch = useRef(0);
  const q = normalizedQuery(query);

  const localMatches = useMemo<CustomerRecord[]>(() => {
    return filterLocalCustomers(
      directory.records,
      q,
      showMine,
      currentUserOpenId,
    );
  }, [q, showMine, currentUserOpenId, directory.records]);

  const runServerSearch = (nextQuery: string, nextShowMine: boolean) => {
    const nextQ = normalizedQuery(nextQuery);
    const nextLocalMatches = logLocalFilter(
      directory.records,
      nextQ,
      nextShowMine,
      currentUserOpenId,
    );
    if (
      !nextQ ||
      (directory.status === "ready" && nextLocalMatches.length > 0)
    ) {
      latestSearch.current += 1;
      setServerMatches([]);
      return;
    }
    const searchId = latestSearch.current + 1;
    latestSearch.current = searchId;
    void searchCustomers(
      nextQ,
      ownerFilter(nextShowMine, currentUserOpenId, nextQ),
    )
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
  const emptyKind = getCustomerSearchEmptyKind(q, showMine, matches.length);
  const resultsOpen = Boolean(q || showMine || matches.length > 0 || emptyKind);
  const handlePanelBlur = () => {
    if (!onDismiss) return;
    window.setTimeout(() => {
      const activeElement = document.activeElement;
      if (activeElement && boundaryRef?.current?.contains(activeElement))
        return;
      onDismiss();
    }, 0);
  };

  const shell = embedded
    ? TASKPANE_SEARCH_PANEL_SHELL_HEADER
    : TASKPANE_SEARCH_PANEL_SHELL;

  return (
    <TaskpanePickerPanel
      as="section"
      title="customer"
      srTitle="Customer"
      titleId="customer-picker-title"
      panelRef={boundaryRef}
      onBlur={handlePanelBlur}
      shellClassName={shell}
      className={`${embedded ? "" : "bg-card-soft rounded-xl shadow-edge"}${exiting ? " panel-exit" : ""}`}
    >
      <TaskpaneSearchDropdown
        label="Search customers"
        value={query}
        onChange={handleQueryChange}
        placeholder="Search by name, domain, account no..."
        open={resultsOpen}
        listLabel="Customer results"
        emptyMessage={customerSearchEmptyMessage(q, showMine, query)}
        onEscape={() => (q ? handleQueryChange("") : onDismiss?.())}
        rightSlot={
          currentUserOpenId ? (
            <button
              type="button"
              aria-pressed={showMine}
              onClick={handleShowMine}
              className="data-[on=true]:bg-accent data-[on=true]:text-accent-foreground text-muted-foreground inline-flex min-h-8 shrink-0 items-center rounded-md px-2.5 text-[11px] font-semibold transition-transform active:scale-[0.96]"
              data-on={showMine}
            >
              Show mine
            </button>
          ) : null
        }
      >
        {matches.length > 0 ? (
          matches.slice(0, 8).map((customer) => (
            <button
              key={customer.recordId}
              type="button"
              data-search-option=""
              onClick={() => {
                dtime(`customer picker: picked "${customer.name}"`, openedAt);
                onSelect(customer);
              }}
              className="bg-card hover:bg-accent data-[keyboard-active=true]:bg-accent sync-enter flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs shadow-edge transition-transform active:scale-[0.96]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">
                  {customer.name}
                </span>
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
        ) : emptyKind ? (
          <CustomerSearchEmptyState
            kind={emptyKind}
            onClearSearch={() => handleQueryChange("")}
          />
        ) : q ? (
          <button
            type="button"
            data-search-option=""
            onClick={() => {
              dtime(`customer picker: create requested "${q}"`, openedAt);
              onCreateCustomer?.(query.trim());
            }}
            className="bg-card hover:bg-accent data-[keyboard-active=true]:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs font-semibold shadow-edge transition-transform active:scale-[0.96]"
          >
            <Plus className="text-primary size-4 shrink-0" />
            <span className="min-w-0 flex-1 truncate">
              Create customer task "{query.trim()}"
            </span>
          </button>
        ) : undefined}
      </TaskpaneSearchDropdown>
    </TaskpanePickerPanel>
  );
}
