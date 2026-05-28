// The Customer Picker card on the contacts screen (ADR-0013). The parent owns
// `selectedCustomer` and computes the initial auto-match via
// findCustomerByEmail; this component is fully controlled — it only displays
// the chosen Customer and exposes a search panel for overrides.

/* eslint-disable max-lines-per-function */
import { useEffect, useState } from "react";
import { Plus, Search, X } from "lucide-react";

import type { CustomerDirectoryState, CustomerRecord } from "./customers";

export interface CustomerPickerProps {
  directory: CustomerDirectoryState;
  searchCustomers: (query: string) => Promise<CustomerRecord[]>;
  emailDomain: string;
  selectedCustomer: CustomerRecord | null;
  onChange: (customer: CustomerRecord | null) => void;
}

export function CustomerPicker({
  directory,
  emailDomain,
  selectedCustomer,
  onChange,
  searchCustomers,
}: CustomerPickerProps) {
  const [searching, setSearching] = useState(false);

  if (searching) {
    return (
      <SearchPanel
        directory={directory}
        searchCustomers={searchCustomers}
        onCancel={() => setSearching(false)}
        onSelect={(c) => {
          onChange(c);
          setSearching(false);
        }}
      />
    );
  }

  return (
    <section className="bg-card-soft rounded-xl px-3 py-2 shadow-[var(--shadow-border)]">
      <div className="flex min-w-0 items-center gap-2">
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
              onClick={() => setSearching(true)}
              className="text-primary inline-flex min-h-8 items-center rounded-md px-2 text-[11px] font-semibold"
            >
              Change
            </button>
          </>
        ) : directory.status === "loading" || directory.status === "idle" ? (
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
            Resolving customer for {emailDomain}…
          </span>
        ) : (
          <NoMatch emailDomain={emailDomain} onSearch={() => setSearching(true)} />
        )}
      </div>
    </section>
  );
}

// Search panel — typing filters the in-memory Customer Directory by a simple
// substring match across name + fullName + accountNo + domain. Per ADR-0013 we
// will swap in Fuse.js ranking once the basic flow is wired; the substring
// fallback is enough to prove the override flow.
function SearchPanel({
  directory,
  searchCustomers,
  onCancel,
  onSelect,
}: {
  directory: CustomerDirectoryState;
  searchCustomers: (query: string) => Promise<CustomerRecord[]>;
  onCancel: () => void;
  onSelect: (c: CustomerRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverMatches, setServerMatches] = useState<CustomerRecord[]>([]);
  const q = query.trim().toLowerCase();
  const localMatches: CustomerRecord[] = q
    ? directory.records.filter(
        (c) =>
          c.name.toLowerCase().includes(q) ||
          (c.fullName?.toLowerCase().includes(q) ?? false) ||
          (c.accountNo?.toLowerCase().includes(q) ?? false) ||
          (c.domain?.toLowerCase().includes(q) ?? false),
      )
    : [];

  useEffect(() => {
    if (!q || (directory.status === "ready" && localMatches.length > 0)) {
      setServerMatches([]);
      return;
    }
    let cancelled = false;
    searchCustomers(q)
      .then((rows) => {
        if (!cancelled) setServerMatches(rows);
      })
      .catch(() => {
        if (!cancelled) setServerMatches([]);
      });
    return () => {
      cancelled = true;
    };
  }, [directory.status, localMatches.length, q, searchCustomers]);

  const matches = localMatches.length > 0 ? localMatches : serverMatches;

  return (
    <section className="bg-card-soft rounded-xl px-3 py-2 shadow-[var(--shadow-border)]">
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-muted-foreground text-[11px] font-semibold uppercase">
          Pick a customer
        </span>
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
      <div className="bg-background flex items-center gap-2 rounded-xl px-3 shadow-[var(--shadow-border)]">
        <Search className="text-primary size-4 shrink-0" />
        <input
          type="search"
          role="searchbox"
          aria-label="Search customers"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by name, domain, account no…"
          className="placeholder:text-muted-foreground h-10 w-full bg-transparent text-sm outline-none"
        />
      </div>
      <ul className="mt-2 space-y-1">
        {matches.slice(0, 8).map((c) => (
          <li key={c.recordId}>
            <button
              type="button"
              onClick={() => onSelect(c)}
              className="bg-card hover:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs shadow-[var(--shadow-border)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{c.name}</span>
                {c.domain ? (
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {c.domain}
                    {c.countryRegion ? ` · ${c.countryRegion}` : ""}
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
// nothing and reserve a placeholder for the future create-new affordance — but
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
