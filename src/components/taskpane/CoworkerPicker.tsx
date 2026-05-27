/* eslint-disable max-lines-per-function */
import { useEffect, useState } from "react";
import { ArrowLeft, Check, Search, UserRound, X } from "lucide-react";

import type { Contact } from "@/forward/targets";

const RECENTS_KEY = "feishu_recent_coworkers";
const SEARCH_DEBOUNCE_MS = 250;

export type SearchCoworkers = (query: string) => Promise<Contact[]>;

function loadRecents(): Contact[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
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
  contact,
  selected,
  onToggle,
}: {
  contact: Contact;
  selected: boolean;
  onToggle: (contact: Contact) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(contact)}
      className="bg-card flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-[var(--shadow-border)] transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] data-[pressed=true]:bg-accent data-[pressed=true]:shadow-[0_0_0_1.5px_var(--primary)]"
      data-pressed={selected}
    >
      <span className="bg-secondary text-primary flex size-10 items-center justify-center rounded-full">
        <UserRound className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{contact.name}</span>
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
        <h1 id="coworker-search-title" className="text-sm font-bold">
          Feishu coworker
        </h1>
      </div>
      <div
        className={
          "bg-background flex items-center gap-2 rounded-xl px-3 shadow-[var(--shadow-border)] transition-[box-shadow] duration-150 " +
          (focused ? "ring-ring/10 ring-[3px]" : "")
        }
      >
        <Search className="text-primary size-4 shrink-0" />
        <input
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
  selectedOpenIds,
  searchCoworkers,
  onToggle,
  onBack,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
  selectedOpenIds: string[];
  searchCoworkers: SearchCoworkers;
  onToggle: (contact: Contact) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<Contact[]>(loadRecents);
  const [results, setResults] = useState<Contact[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);

  const q = query.trim();

  useEffect(() => {
    if (!q) {
      setResults([]);
      setSearching(false);
      setSearchError(null);
      return;
    }

    let cancelled = false;
    setSearching(true);
    setSearchError(null);
    const timer = window.setTimeout(() => {
      void searchCoworkers(q)
        .then((contacts) => {
          if (!cancelled) setResults(contacts);
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setResults([]);
            setSearchError(err instanceof Error ? err.message : "Could not search coworkers.");
          }
        })
        .finally(() => {
          if (!cancelled) setSearching(false);
        });
    }, SEARCH_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, searchCoworkers]);

  const list = q ? results : recents;
  const listLabel = q ? "Results" : recents.length > 0 ? "Recent" : "Search";

  const handleToggle = (contact: Contact) => {
    const next = [contact, ...loadRecents().filter((c) => c.openId !== contact.openId)].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
    setRecents(next);
    onToggle(contact);
  };

  return (
    <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-3 pb-2">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-primary mb-3 inline-flex min-h-10 items-center gap-2 text-xs font-semibold transition-[color] duration-150"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>
      <header className="px-1 pb-2">
        <div className="text-accent-foreground mb-1.5 flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Client &amp; coworker
        </div>
      </header>

      <ClientInfo clientEmail={clientEmail} onClientEmailChange={onClientEmailChange} />

      <CoworkerSearchSection
        query={query}
        focused={focused}
        onQueryChange={setQuery}
        onFocusChange={setFocused}
      />

      <div className="text-muted-foreground mt-4 mb-2 px-1 text-[11px] font-semibold tracking-wide uppercase">
        {listLabel}
      </div>
      <div className="space-y-2">
        {searching ? (
          <p className="text-muted-foreground px-1 py-2 text-sm">Searching...</p>
        ) : searchError ? (
          <p className="text-destructive px-1 py-2 text-sm">{searchError}</p>
        ) : list.length > 0 ? (
          list.map((contact) => (
            <CoworkerOption
              key={contact.openId}
              contact={contact}
              selected={selectedOpenIds.includes(contact.openId)}
              onToggle={handleToggle}
            />
          ))
        ) : q ? (
          <p className="text-muted-foreground px-1 py-2 text-sm">No coworkers match "{query}"</p>
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-sm">Search by name to add a coworker.</p>
        )}
      </div>
    </div>
  );
}
