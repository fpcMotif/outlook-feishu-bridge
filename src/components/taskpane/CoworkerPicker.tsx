/* eslint-disable max-lines-per-function */
import * as React from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Check, Search, UserRound, X } from "lucide-react";

import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";

// Dev/preview fallback directory, used only when the live Feishu search is
// unavailable (browser preview has no Convex user session). In real Outlook the
// search hook returns actual coworkers (real open_ids). See ADR-0003.
const PREVIEW_COWORKERS: Coworker[] = [
  { openId: "ou_jenny", name: "Jenny Xu" },
  { openId: "ou_michael", name: "Michael Chen" },
  { openId: "ou_sales_ops", name: "Sales Ops" },
  { openId: "ou_wei", name: "Wei Liang" },
  { openId: "ou_maria", name: "Maria Hoffmann" },
  { openId: "ou_carlos", name: "Carlos Mendez" },
  { openId: "ou_aiko", name: "Aiko Tanaka" },
  { openId: "ou_lena", name: "Lena Fischer" },
];

const RECENTS_KEY = "feishu_recent_coworkers";
const SEARCH_DEBOUNCE_MS = 250;

function loadRecents(): Coworker[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Coworker[]) : [];
  } catch {
    return [];
  }
}

function sameCoworkers(a: Coworker[], b: Coworker[]) {
  return (
    a.length === b.length &&
    a.every(
      (coworker, index) =>
        coworker.openId === b[index]?.openId &&
        coworker.name === b[index]?.name &&
        coworker.avatarUrl === b[index]?.avatarUrl,
    )
  );
}

function searchResultsReducer(state: Coworker[], results: Coworker[]) {
  return sameCoworkers(state, results) ? state : results;
}

function ClientInfo({
  clientEmail,
  onClientEmailChange,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
}) {
  return (
    <section className="bg-card-soft rounded-xl px-3 py-2 shadow-[var(--shadow-border)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-[11px] font-semibold uppercase">
          Client email
        </span>
        <span className="bg-border h-3 w-px shrink-0" />
        <input
          aria-label="Client email"
          type="email"
          value={clientEmail}
          onChange={(e) => onClientEmailChange(e.target.value)}
          placeholder="client@example.com"
          className="placeholder:text-muted-foreground min-h-10 min-w-0 flex-1 bg-transparent text-xs font-semibold outline-none"
        />
      </div>
    </section>
  );
}

function CoworkerOption({
  coworker,
  selected,
  onSelect,
}: {
  coworker: Coworker;
  selected: boolean;
  onSelect: (coworker: Coworker) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(coworker)}
      className="bg-card flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-[var(--shadow-border)] transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] data-[pressed=true]:bg-accent data-[pressed=true]:shadow-[0_0_0_1.5px_var(--primary)]"
      data-pressed={selected}
    >
      <span className="bg-secondary text-primary flex size-10 items-center justify-center rounded-full">
        <UserRound className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{coworker.name}</span>
        <span className="text-muted-foreground block truncate text-xs">Feishu coworker</span>
      </span>
      {selected ? <Check className="text-primary size-5" /> : null}
    </button>
  );
}

function CoworkerSearchSection({
  query,
  focused,
  onQueryChange,
  onFocusChange,
}: {
  query: string;
  focused: boolean;
  onQueryChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <section
      aria-labelledby="coworker-search-title"
      className="bg-card mt-3 rounded-[18px] p-2 shadow-[var(--shadow-floating)]"
    >
      <div className="flex items-center px-2 pt-1 pb-2">
        <h2 id="coworker-search-title" className="text-sm font-bold">
          Feishu coworker
        </h2>
      </div>
      <div
        className={
          "bg-background flex items-center gap-2 rounded-xl px-3 shadow-[var(--shadow-border)] transition-[box-shadow] duration-150 " +
          (focused ? "ring-ring/10 ring-[3px]" : "")
        }
      >
        <Search className="text-primary size-4 shrink-0" />
        <input
          aria-label="Search Feishu coworkers"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          onFocus={() => onFocusChange(true)}
          onBlur={() => onFocusChange(false)}
          placeholder="Search Feishu coworkers..."
          className="placeholder:text-muted-foreground h-11 w-full bg-transparent text-sm outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => onQueryChange("")}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground inline-flex min-h-10 min-w-10 items-center justify-center"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function CoworkerPicker({
  clientEmail,
  onClientEmailChange,
  customerSlot,
  sessionId,
  userAccessToken,
  selectedOpenId,
  onSelect,
  usePreviewCoworkers = false,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
  customerSlot?: React.ReactNode;
  sessionId: string;
  userAccessToken?: string;
  selectedOpenId?: string;
  onSelect: (coworker: Coworker) => void;
  usePreviewCoworkers?: boolean;
}) {
  const search = useCoworkerSearch(sessionId, userAccessToken);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);

  const q = query.trim();

  // Live search (debounced). On failure (no session / browser preview) fall back
  // to the preview directory so the demo still works.
  useEffect(() => {
    if (!q) {
      dispatchResults([]);
      return;
    }
    const previewMatches = PREVIEW_COWORKERS.filter((c) =>
      c.name.toLowerCase().includes(q.toLowerCase()),
    );
    if (usePreviewCoworkers) {
      dispatchResults(previewMatches);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      search(q)
        .then((found) => {
          if (!cancelled) dispatchResults(found);
        })
        .catch(() => {
          if (!cancelled) dispatchResults(previewMatches);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, search, usePreviewCoworkers]);

  const directoryById = useMemo(() => {
    const map = new Map<string, Coworker>();
    for (const c of [...PREVIEW_COWORKERS, ...recents, ...results]) map.set(c.openId, c);
    return map;
  }, [recents, results]);

  const searching = q.length > 0;
  const selectedCoworker = selectedOpenId ? directoryById.get(selectedOpenId) : undefined;
  const list = searching ? results : selectedCoworker ? [selectedCoworker] : [];
  const listLabel = searching ? "Results" : selectedCoworker ? "Current coworker" : "";

  const handleSelect = (coworker: Coworker) => {
    const next = [coworker, ...loadRecents().filter((c) => c.openId !== coworker.openId)].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
    setRecents(next);
    onSelect(coworker);
  };

  return (
    <section aria-labelledby="client-coworker-title" className="space-y-3">
      <header className="px-1">
        <div
          id="client-coworker-title"
          className="text-accent-foreground flex items-center gap-2 text-[11px] font-semibold uppercase"
        >
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Client &amp; coworker
        </div>
      </header>

      <ClientInfo clientEmail={clientEmail} onClientEmailChange={onClientEmailChange} />
      {customerSlot ? <div>{customerSlot}</div> : null}

      <CoworkerSearchSection
        query={query}
        focused={focused}
        onQueryChange={setQuery}
        onFocusChange={setFocused}
      />

      {listLabel ? (
        <div className="text-muted-foreground mt-4 mb-2 px-1 text-[11px] font-semibold tracking-wide uppercase">
          {listLabel}
        </div>
      ) : null}
      <div className="space-y-2">
        {list.length > 0 ? (
          list.map((coworker) => (
            <CoworkerOption
              key={coworker.openId}
              coworker={directoryById.get(coworker.openId) ?? coworker}
              selected={selectedOpenId === coworker.openId}
              onSelect={handleSelect}
            />
          ))
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-sm">
            {searching ? `No coworkers match "${query}"` : "Search by name to choose a Feishu coworker"}
          </p>
        )}
      </div>
    </section>
  );
}
