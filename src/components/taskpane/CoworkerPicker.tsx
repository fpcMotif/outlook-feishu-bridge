/* eslint-disable max-lines-per-function, max-lines */
import * as React from "react";
import { useEffect, useMemo, useReducer, useState } from "react";
import { AtSign, Check, UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";
import { TaskpaneSearchDropdown } from "./TaskpaneSearchDropdown";
import { TaskpaneSection } from "./TaskpaneSection";

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
const MIN_REMOTE_COWORKER_SEARCH_LENGTH = 2;
const MIN_EMAIL_FIELD_HEIGHT = 32;

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
  const emailRef = React.useRef<HTMLTextAreaElement>(null);

  React.useLayoutEffect(() => {
    const email = emailRef.current;
    if (!email) return;

    const resizeEmail = () => {
      email.style.height = "0px";
      email.style.height = `${Math.max(MIN_EMAIL_FIELD_HEIGHT, email.scrollHeight)}px`;
    };

    resizeEmail();
    window.addEventListener("resize", resizeEmail);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeEmail);
    observer?.observe(email.parentElement ?? email);

    return () => {
      window.removeEventListener("resize", resizeEmail);
      observer?.disconnect();
    };
  }, [clientEmail]);

  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2" data-client-row="true">
      <span
        className="text-muted-foreground flex size-8 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AtSign className="size-4" />
      </span>
      <textarea
        ref={emailRef}
        aria-label="Email"
        inputMode="email"
        autoCapitalize="none"
        autoComplete="email"
        value={clientEmail}
        onChange={(e) => onClientEmailChange(e.target.value.replaceAll(/\s+/g, ""))}
        placeholder="email@example.com"
        rows={1}
        spellCheck={false}
        className="placeholder:text-muted-foreground min-h-8 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-2 text-xs leading-4 font-semibold outline-none [overflow-wrap:anywhere] [word-break:break-word]"
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
      data-search-option=""
      aria-selected={false}
      onClick={() => onSelect(coworker)}
      className="bg-card flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-edge transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] outline-none active:scale-[0.97] data-[selected=true]:bg-accent data-[selected=true]:shadow-[0_0_0_1.5px_var(--primary)] aria-selected:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/20"
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
    <div className="bg-accent text-accent-foreground border-accent-foreground/15 mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 shadow-edge">
      <Check className="text-primary size-4 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-semibold uppercase">Selected</span>
      <span className="min-w-0 truncate text-sm font-semibold">{coworker.name}</span>
    </div>
  );
}

function CoworkerSearchSection({
  query,
  onQueryChange,
  open,
  children,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="coworker-search-title"
      className="bg-card-soft mt-3 rounded-xl px-3 py-2 shadow-edge"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2
          id="coworker-search-title"
          className="text-muted-foreground text-[11px] font-semibold uppercase"
        >
          Feishu coworker
        </h2>
      </div>
      <TaskpaneSearchDropdown
        label="Search Feishu coworkers"
        value={query}
        onChange={onQueryChange}
        placeholder="Search Feishu coworkers..."
        open={open}
        listLabel="Search results"
        emptyMessage={`No real Feishu coworkers match "${query}"`}
      >
        {children}
      </TaskpaneSearchDropdown>
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
    if (usePreviewCoworkers) {
      const previewQuery = q.toLowerCase();
      const previewMatches = PREVIEW_COWORKERS.filter((c) =>
        c.name.toLowerCase().includes(previewQuery),
      );
      dispatchResults(previewMatches);
      return;
    }
    if (q.length < MIN_REMOTE_COWORKER_SEARCH_LENGTH) {
      dispatchResults([]);
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

  const searching = usePreviewCoworkers
    ? q.length > 0
    : q.length >= MIN_REMOTE_COWORKER_SEARCH_LENGTH;
  const selectedCoworker = selectedOpenId ? directoryById.get(selectedOpenId) : undefined;

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
    <TaskpaneSection id="client-coworker-title" title="Customer & coworker">
      <section className="bg-card-soft overflow-visible rounded-xl shadow-edge">
        <ClientInfo clientEmail={clientEmail} onClientEmailChange={onClientEmailChange} />
        {customerSlot ? <div className="border-border border-t">{customerSlot}</div> : null}
      </section>

      <CoworkerSearchSection query={query} onQueryChange={setQuery} open={searching}>
        {results.length > 0
          ? results.map((coworker) => (
                  <CoworkerOption
                    key={coworker.openId}
                    coworker={directoryById.get(coworker.openId) ?? coworker}
                    selected={selectedOpenId === coworker.openId}
                    onSelect={handleSelect}
                  />
                ))
          : null}
      </CoworkerSearchSection>

      {!searching && selectedCoworker ? <SelectedCoworkerCard coworker={selectedCoworker} /> : null}
    </TaskpaneSection>
  );
}
