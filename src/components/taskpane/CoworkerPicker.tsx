/* eslint-disable max-lines-per-function, max-lines */
import * as React from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import { AtSign, Check, UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";
import { SectionLabel } from "./SectionLabel";
import { TaskpaneSearchField } from "./TaskpaneSearchField";

// Test fixture directory. These made-up coworkers are allowed only when an
// e2e/dev-test harness explicitly opts in; production search must never fall
// back to them. Real user-visible results come only from Feishu Search Users.
// See ADR-0003.
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
    <div className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2" data-client-row="true">
      <span
        className="text-muted-foreground flex size-8 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AtSign className="size-4" />
      </span>
      <input
        aria-label="Email"
        type="email"
        value={clientEmail}
        onChange={(e) => onClientEmailChange(e.target.value.replaceAll(/\s+/g, ""))}
        placeholder="email@example.com"
        spellCheck={false}
        className="placeholder:text-muted-foreground h-8 min-w-0 flex-1 bg-transparent text-xs leading-8 font-semibold outline-none"
      />
    </div>
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
      className="bg-card flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-[var(--shadow-border)] transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] outline-none active:scale-[0.97] data-[selected=true]:bg-accent data-[selected=true]:shadow-[0_0_0_1.5px_var(--primary)] focus-visible:ring-[3px] focus-visible:ring-ring/15"
      data-selected={selected}
    >
      <Avatar className="size-10 bg-secondary">
        {coworker.avatarUrl ? <AvatarImage src={coworker.avatarUrl} alt="" /> : null}
        <AvatarFallback className="bg-secondary text-primary">
          <UserRound className="size-5" />
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{coworker.name}</span>
        <span className="text-muted-foreground block truncate text-xs">Feishu coworker</span>
      </span>
      {selected ? <Check className="text-primary size-5" /> : null}
    </button>
  );
}

function SelectedCoworkerCard({ coworker }: { coworker: Coworker }) {
  return (
    <div className="bg-accent text-accent-foreground mt-2 flex items-center gap-2 rounded-xl px-3 py-2 shadow-[var(--shadow-border)]">
      <Check className="text-primary size-4 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-semibold uppercase">Selected</span>
      <span className="min-w-0 truncate text-sm font-semibold">{coworker.name}</span>
    </div>
  );
}

function CoworkerSearchSection({
  query,
  onQueryChange,
  children,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="coworker-search-title"
      className="bg-card-soft mt-3 rounded-xl px-3 py-2 shadow-[var(--shadow-border)]"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2
          id="coworker-search-title"
          className="text-muted-foreground text-[11px] font-semibold uppercase"
        >
          Feishu coworker
        </h2>
      </div>
      <div className="relative">
        <TaskpaneSearchField
          label="Search Feishu coworkers"
          value={query}
          onChange={onQueryChange}
          placeholder="Search Feishu coworkers..."
        />
        {children}
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
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);

  const q = query.trim();

  // Live search (debounced). User-visible results are either Feishu Search Users
  // results, or explicit test fixtures when an e2e/dev-test harness opts in.
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
          if (!cancelled) dispatchResults([]);
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, search, usePreviewCoworkers]);

  const directoryById = useMemo(() => {
    const map = new Map<string, Coworker>();
    const fixtureCoworkers = usePreviewCoworkers ? PREVIEW_COWORKERS : [];
    for (const c of [...fixtureCoworkers, ...recents, ...results]) map.set(c.openId, c);
    return map;
  }, [recents, results, usePreviewCoworkers]);

  const searching = q.length > 0;
  const selectedCoworker = selectedOpenId ? directoryById.get(selectedOpenId) : undefined;
  const listboxId = "coworker-search-results";

  const handleSelect = (coworker: Coworker) => {
    const next = [coworker, ...loadRecents().filter((c) => c.openId !== coworker.openId)].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
    setRecents(next);
    setQuery("");
    onSelect(coworker);
  };

  return (
    <section aria-labelledby="client-coworker-title" className="space-y-3">
      <header className="px-1">
        <SectionLabel id="client-coworker-title">Customer &amp; coworker</SectionLabel>
      </header>

      <section className="bg-card-soft overflow-hidden rounded-xl shadow-[var(--shadow-border)]">
        <ClientInfo clientEmail={clientEmail} onClientEmailChange={onClientEmailChange} />
        {customerSlot ? <div className="border-border border-t">{customerSlot}</div> : null}
      </section>

      <CoworkerSearchSection query={query} onQueryChange={setQuery}>
        {searching ? (
          <div
            id={listboxId}
            role="menu"
            aria-label="Feishu coworker search results"
            className="bg-popover text-popover-foreground absolute inset-x-0 top-[calc(100%+0.5rem)] z-30 max-h-72 overflow-y-auto rounded-2xl border p-1.5 shadow-[var(--shadow-floating)]"
          >
            <div className="text-muted-foreground px-2 py-1.5 text-[11px] font-semibold tracking-wide uppercase">
              Search results
            </div>
            <div className="space-y-1.5">
              {results.length > 0 ? (
                results.map((coworker) => (
                  <CoworkerOption
                    key={coworker.openId}
                    coworker={directoryById.get(coworker.openId) ?? coworker}
                    selected={selectedOpenId === coworker.openId}
                    onSelect={handleSelect}
                  />
                ))
              ) : (
                <div className="text-muted-foreground rounded-xl p-3 text-sm">
                  No real Feishu coworkers match "{query}"
                </div>
              )}
            </div>
          </div>
        ) : null}
      </CoworkerSearchSection>

      {!searching && selectedCoworker ? <SelectedCoworkerCard coworker={selectedCoworker} /> : null}
    </section>
  );
}
