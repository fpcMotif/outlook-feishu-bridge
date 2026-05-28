// The Customer Picker card on the contacts screen (ADR-0013). The parent owns
// `selectedCustomer` and computes the initial auto-match via
// findCustomerByEmail; this component is fully controlled — it only displays
// the chosen Customer and exposes a search panel for overrides.

/* eslint-disable max-lines-per-function */
import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Search, X } from "lucide-react";

import type { CustomerDirectoryState, CustomerRecord } from "./customers";
import { dlog, dtime } from "../../debug";

export interface CustomerPickerProps {
  directory: CustomerDirectoryState;
  searchCustomers: (query: string) => Promise<CustomerRecord[]>;
  /** Optional fire-and-forget refresh: when present, the SearchPanel calls it
   *  on mount so opening the picker triggers a fresh sync (ADR-0016). */
  triggerRefresh?: () => void;
  emailDomain: string;
  selectedCustomer: CustomerRecord | null;
  // The signed-in Feishu user's open_id (the Initiator, ADR-0014). When
  // provided, the search panel offers a "Show mine" quick toggle that filters
  // the directory to customers whose Owner column equals this open_id.
  currentUserOpenId?: string;
  onChange: (customer: CustomerRecord | null) => void;
}

export function CustomerPicker({
  directory,
  emailDomain,
  selectedCustomer,
  currentUserOpenId,
  onChange,
  searchCustomers,
  triggerRefresh,
}: CustomerPickerProps) {
  const [searching, setSearching] = useState(false);

  if (searching) {
    return (
      <SearchPanel
        directory={directory}
        searchCustomers={searchCustomers}
        triggerRefresh={triggerRefresh}
        currentUserOpenId={currentUserOpenId}
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
// substring match across name + fullName + accountNo + domain + owner.name.
// A "Show mine" toggle additionally narrows to customers whose Owner column
// equals the signed-in user's open_id. Substring + per-keystroke filtering is
// enough at the current ~250-row scale; if rank quality becomes an issue at
// ~5000 we swap in Fuse.js (ADR-0013 future work).
function SearchPanel({
  directory,
  searchCustomers,
  triggerRefresh,
  currentUserOpenId,
  onCancel,
  onSelect,
}: {
  directory: CustomerDirectoryState;
  searchCustomers: (query: string) => Promise<CustomerRecord[]>;
  triggerRefresh?: () => void;
  currentUserOpenId?: string;
  onCancel: () => void;
  onSelect: (c: CustomerRecord) => void;
}) {
  const [query, setQuery] = useState("");
  const [serverMatches, setServerMatches] = useState<CustomerRecord[]>([]);
  const [showMine, setShowMine] = useState(false);
  const q = query.trim().toLowerCase();
  const openedAt = useRef<number>(performance.now());
  useEffect(() => {
    dlog(
      `customer picker: search opened (directory ${directory.status}, ${directory.records.length} rows)`,
    );
    // ADR-0016: refresh on user trigger. The weekly cron handles background
    // freshness; opening the panel is the explicit "I care about freshness
    // right now" signal, so kick a sync. Fire-and-forget.
    if (triggerRefresh) triggerRefresh();
    return () => {
      dtime("customer picker: search closed", openedAt.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply "Show mine" first (cheap predicate), then the substring query. Wrap
  // in useMemo + dtime so each keystroke's local-filter cost is visible in the
  // DebugPanel — the central claim of "instant" is auditable, not anecdotal.
  const localMatches = useMemo<CustomerRecord[]>(() => {
    if (!q && !showMine) return [];
    const started = performance.now();
    const ownedByMe = (c: CustomerRecord) =>
      !showMine || (currentUserOpenId !== undefined && c.owner?.openId === currentUserOpenId);
    const matchesText = (c: CustomerRecord) =>
      !q ||
      c.name.toLowerCase().includes(q) ||
      (c.fullName?.toLowerCase().includes(q) ?? false) ||
      (c.accountNo?.toLowerCase().includes(q) ?? false) ||
      (c.domain?.toLowerCase().includes(q) ?? false) ||
      (c.owner?.name?.toLowerCase().includes(q) ?? false);
    const out = directory.records.filter((c) => ownedByMe(c) && matchesText(c));
    dtime(
      `customer picker: local filter "${q.slice(0, 40)}"${showMine ? " +mine" : ""} → ${out.length}/${directory.records.length}`,
      started,
    );
    return out;
  }, [q, showMine, currentUserOpenId, directory.records]);

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
        <div className="flex items-center gap-1">
          {currentUserOpenId ? (
            <button
              type="button"
              aria-pressed={showMine}
              onClick={() => setShowMine((v) => !v)}
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
              onClick={() => {
                dtime(`customer picker: picked "${c.name}"`, openedAt.current);
                onSelect(c);
              }}
              className="bg-card hover:bg-accent flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-xs shadow-[var(--shadow-border)]"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-semibold">{c.name}</span>
                {c.domain || c.countryRegion || c.owner ? (
                  <span className="text-muted-foreground block truncate text-[11px]">
                    {[c.domain, c.countryRegion, c.owner ? `owned by ${c.owner.name}` : null]
                      .filter(Boolean)
                      .join(" · ")}
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
