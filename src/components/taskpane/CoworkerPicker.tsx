/* eslint-disable max-lines-per-function, max-lines */
import * as React from "react";
import {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";
import { Check, UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/design-system";
import {
  TaskpaneInsetDivider,
  TaskpaneSearchDropdown,
  TaskpaneSection,
  TaskpaneSelectionRow,
} from "@/design-system/taskpane";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";
import { TaskpaneCardBoundaryContext } from "./taskpaneCardBoundary";
import { TaskpanePickerPanel } from "./TaskpanePickerPanel";
import { TASKPANE_SEARCH_PANEL_SHELL_FOOTER } from "./taskpaneSearchPanelLayout";

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

const COWORKER_FALLBACK_ICON = (
  <UserRound className="size-4" strokeWidth={1.8} aria-hidden="true" />
);

/** Search dropdown + image-error fallback — single person glyph (matches SalesPicker). */
const SEARCH_PERSON_FALLBACK_ICON = (
  <UserRound className="size-5" strokeWidth={1.8} aria-hidden="true" />
);

function CoworkerSelectedLeading({ avatarUrl }: { avatarUrl?: string }) {
  return (
    <Avatar className="size-8 bg-secondary">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="bg-secondary text-muted-foreground">
        {COWORKER_FALLBACK_ICON}
      </AvatarFallback>
    </Avatar>
  );
}

export function CoworkerOption({
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
      onClick={() => onSelect(coworker)}
      className="bg-card flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-edge transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] outline-none active:scale-[0.97] data-[selected=true]:bg-accent data-[selected=true]:shadow-[0_0_0_1.5px_var(--primary)] data-[keyboard-active=true]:bg-secondary focus-visible:ring-[3px] focus-visible:ring-ring/20"
      data-selected={selected}
    >
      <Avatar className="size-10 bg-secondary">
        {coworker.avatarUrl ? (
          <AvatarImage src={coworker.avatarUrl} alt="" />
        ) : null}
        <AvatarFallback className="bg-secondary text-muted-foreground/70">
          {SEARCH_PERSON_FALLBACK_ICON}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">
          {coworker.name}
        </span>
        <span className="text-muted-foreground block truncate text-xs">
          Feishu coworker
        </span>
      </span>
      {selected ? <Check className="text-primary size-5" /> : null}
    </button>
  );
}

function CoworkerSearchPanel({
  query,
  onQueryChange,
  open,
  children,
  dismissable = false,
  onDismiss,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  children?: React.ReactNode;
  dismissable?: boolean;
  onDismiss?: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!dismissable || !onDismiss) return;
    const dismiss = onDismiss;
    function onPointer(event: MouseEvent) {
      if (
        panelRef.current &&
        !panelRef.current.contains(event.target as Node)
      ) {
        dismiss();
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [dismissable, onDismiss]);

  return (
    <TaskpanePickerPanel
      title="coworker"
      srTitle="Coworker"
      titleId="coworker-picker-title"
      panelRef={panelRef}
      shellClassName={TASKPANE_SEARCH_PANEL_SHELL_FOOTER}
    >
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
    </TaskpanePickerPanel>
  );
}

export function CoworkerPicker({
  customerSlot,
  salesSlot,
  sessionId,
  userAccessToken,
  selectedCoworker: selectedCoworkerProp,
  onSelect,
  usePreviewCoworkers = false,
}: {
  customerSlot?: React.ReactNode;
  /** Sales rep row — rendered between customer and coworker (ADR-0014 picker). */
  salesSlot?: React.ReactNode;
  sessionId: string;
  userAccessToken?: string;
  /** Authoritative selection from intake state (survives outside search/recents maps). */
  selectedCoworker?: Coworker | null;
  onSelect: (coworker: Coworker) => void;
  usePreviewCoworkers?: boolean;
}) {
  const search = useCoworkerSearch(sessionId, userAccessToken);
  const [query, setQuery] = useState("");
  const [changingCoworker, setChangingCoworker] = useState(false);
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);
  const cardRef = useRef<HTMLElement>(null);

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
    for (const c of [...fixtureCoworkers, ...recents, ...results])
      map.set(c.openId, c);
    return map;
  }, [recents, results, usePreviewCoworkers]);

  const searching = q.length > 0;
  const selectedCoworker = selectedCoworkerProp ?? undefined;
  const showCoworkerSearch = !selectedCoworker || changingCoworker;
  const dismissCoworkerSearch = useCallback(() => {
    setQuery("");
    setChangingCoworker(false);
  }, []);

  const handleSelect = (coworker: Coworker) => {
    const next = [
      coworker,
      ...loadRecents().filter((c) => c.openId !== coworker.openId),
    ].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
    setRecents(next);
    dismissCoworkerSearch();
    onSelect(coworker);
  };

  const selectedLeading = useMemo(
    () =>
      selectedCoworker ? (
        <CoworkerSelectedLeading avatarUrl={selectedCoworker.avatarUrl} />
      ) : undefined,
    [selectedCoworker],
  );

  const coworkerContent =
    selectedCoworker && !showCoworkerSearch ? (
      <TaskpanePickerPanel
        title="coworker"
        srTitle="Coworker"
        titleId="coworker-picker-title"
        shellClassName={TASKPANE_SEARCH_PANEL_SHELL_FOOTER}
      >
        <TaskpaneSelectionRow
          dataRow="coworker"
          leading={selectedLeading}
          label={selectedCoworker.name}
          inset={false}
          onChange={() => {
            setChangingCoworker(true);
            setQuery("");
          }}
        />
      </TaskpanePickerPanel>
    ) : showCoworkerSearch ? (
      <CoworkerSearchPanel
        query={query}
        onQueryChange={setQuery}
        open={searching}
        dismissable={changingCoworker || q.length > 0}
        onDismiss={dismissCoworkerSearch}
      >
        {results.length > 0
          ? results.map((coworker) => (
              <CoworkerOption
                key={coworker.openId}
                coworker={directoryById.get(coworker.openId) ?? coworker}
                selected={selectedCoworker?.openId === coworker.openId}
                onSelect={handleSelect}
              />
            ))
          : null}
      </CoworkerSearchPanel>
    ) : null;

  return (
    <TaskpaneSection id="client-coworker-title" title="Participants">
      <TaskpaneCardBoundaryContext.Provider value={cardRef}>
        <section
          ref={cardRef}
          className="bg-card-soft overflow-visible rounded-lg shadow-edge"
        >
          {customerSlot ? <div>{customerSlot}</div> : null}
          {customerSlot && salesSlot ? <TaskpaneInsetDivider /> : null}
          {salesSlot ? <div>{salesSlot}</div> : null}
          {(salesSlot ?? customerSlot) && coworkerContent ? (
            <TaskpaneInsetDivider />
          ) : null}
          {coworkerContent ? <div>{coworkerContent}</div> : null}
        </section>
      </TaskpaneCardBoundaryContext.Provider>
    </TaskpaneSection>
  );
}
