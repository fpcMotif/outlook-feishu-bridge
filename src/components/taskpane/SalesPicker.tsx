/* eslint-disable max-lines-per-function */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { UserRound } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { CoworkerOption } from "./CoworkerPicker";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";
import { TaskpaneSearchDropdown } from "./TaskpaneSearchDropdown";
import { TaskpaneSelectionRow } from "./TaskpaneSelectionRow";
import { useOutsidePointerDismiss } from "./taskpaneOutsideDismiss";
import {
  TASKPANE_SEARCH_PANEL_HEADER,
  TASKPANE_SEARCH_PANEL_SHELL_HEADER,
  TASKPANE_SEARCH_PANEL_TITLE,
} from "./taskpaneSearchPanelLayout";

const PREVIEW_JENNY_AVATAR = "https://example.test/jenny.png";

const PREVIEW_SALES: Coworker[] = [
  { openId: "ou_jenny", name: "Jenny Xu", avatarUrl: PREVIEW_JENNY_AVATAR },
  { openId: "ou_michael", name: "Michael Chen" },
];

const RECENTS_KEY = "feishu_recent_sales";
const SEARCH_DEBOUNCE_MS = 250;

function SalesSelectedLeading({ avatarUrl }: { avatarUrl?: string }) {
  return (
    <Avatar className="bg-background size-8 shadow-[inset_0_0_0_1px_rgba(0,0,0,0.08)] dark:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.1)]">
      {avatarUrl ? <AvatarImage src={avatarUrl} alt="" /> : null}
      <AvatarFallback className="bg-background text-muted-foreground/70">
        <UserRound className="size-4" strokeWidth={1.8} aria-hidden="true" />
      </AvatarFallback>
    </Avatar>
  );
}

function loadRecents(): Coworker[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Coworker[]) : [];
  } catch {
    return [];
  }
}

function samePeople(a: Coworker[], b: Coworker[]) {
  return (
    a.length === b.length &&
    a.every(
      (person, index) =>
        person.openId === b[index]?.openId &&
        person.name === b[index]?.name &&
        person.avatarUrl === b[index]?.avatarUrl,
    )
  );
}

function searchResultsReducer(state: Coworker[], results: Coworker[]) {
  return samePeople(state, results) ? state : results;
}

function SalesSearchPanel({
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

  useOutsidePointerDismiss(panelRef, onDismiss ?? (() => {}), dismissable && Boolean(onDismiss));

  return (
    <div
      ref={panelRef}
      className={TASKPANE_SEARCH_PANEL_SHELL_HEADER}
      aria-labelledby="sales-search-title"
    >
      <div className={TASKPANE_SEARCH_PANEL_HEADER}>
        <span id="sales-search-title" className={TASKPANE_SEARCH_PANEL_TITLE}>
          Pick a sales
        </span>
      </div>
      <TaskpaneSearchDropdown
        label="Search Feishu sales"
        value={query}
        onChange={onQueryChange}
        placeholder="Search Feishu sales..."
        open={open}
        listLabel="Search results"
        emptyMessage={`No Feishu users match "${query}"`}
      >
        {children}
      </TaskpaneSearchDropdown>
    </div>
  );
}

export function SalesPicker({
  sessionId,
  userAccessToken,
  selectedSales = null,
  onSelect,
  usePreviewCoworkers = false,
  salesFromDefault = false,
}: {
  sessionId: string;
  userAccessToken?: string;
  selectedSales?: Coworker | null;
  onSelect: (sales: Coworker) => void;
  usePreviewCoworkers?: boolean;
  /** True when `selectedSales` was set by the signed-in user default (not an explicit pick). */
  salesFromDefault?: boolean;
}) {
  const search = useCoworkerSearch(sessionId, userAccessToken);
  const [query, setQuery] = useState("");
  const [changing, setChanging] = useState(false);
  const [enterStagger, setEnterStagger] = useState(false);
  const prevSelectedOpenId = useRef<string | null>(null);
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);
  // True while a debounced search for the current query is still in flight, so
  // the dropdown shows a pending row instead of flashing the "no match" empty
  // message before results land.
  const [pending, setPending] = useState(false);

  const q = query.trim();

  // Trigger the enter-stagger animation on the empty→selected transition, and only
  // when the selection came from the signed-in default. Adjusted during render via
  // the prev-prop comparison (NOT a useEffect — that trips react-doctor
  // no-adjust-state-on-prop-change; render-phase is the project convention).
  const selectedOpenId = selectedSales?.openId ?? null;
  if (selectedOpenId !== prevSelectedOpenId.current) {
    const wasEmpty = prevSelectedOpenId.current === null;
    prevSelectedOpenId.current = selectedOpenId;
    setEnterStagger(selectedOpenId !== null && wasEmpty && salesFromDefault);
  }

  useEffect(() => {
    if (!q) {
      dispatchResults([]);
      setPending(false);
      return;
    }
    if (usePreviewCoworkers) {
      dispatchResults(
        PREVIEW_SALES.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())),
      );
      setPending(false);
      return;
    }
    let cancelled = false;
    setPending(true);
    const timer = window.setTimeout(() => {
      search(q)
        .then((found) => {
          if (!cancelled) {
            dispatchResults(found);
            setPending(false);
          }
        })
        .catch(() => {
          if (!cancelled) {
            dispatchResults([]);
            setPending(false);
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, search, usePreviewCoworkers]);

  const directoryById = useMemo(() => {
    const map = new Map<string, Coworker>();
    const fixtures = usePreviewCoworkers ? PREVIEW_SALES : [];
    for (const c of [...fixtures, ...recents, ...results]) map.set(c.openId, c);
    return map;
  }, [recents, results, usePreviewCoworkers]);

  const searching = q.length > 0;
  const showSearch = !selectedSales || changing;
  const dismissSearch = useCallback(() => {
    setQuery("");
    setChanging(false);
  }, []);

  const handleSelect = (sales: Coworker) => {
    const next = [sales, ...loadRecents().filter((c) => c.openId !== sales.openId)].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
    setRecents(next);
    dismissSearch();
    onSelect(sales);
  };

  const selectedLeading = useMemo(
    () =>
      selectedSales ? (
        <SalesSelectedLeading avatarUrl={selectedSales.avatarUrl} />
      ) : undefined,
    [selectedSales],
  );

  if (!showSearch) {
    return (
      <TaskpaneSelectionRow
        dataRow="sales"
        leading={selectedLeading}
        label={selectedSales.name}
        enterStagger={enterStagger}
        onChange={() => {
          setChanging(true);
          setQuery("");
        }}
      />
    );
  }

  return (
    <SalesSearchPanel
      query={query}
      onQueryChange={setQuery}
      open={searching}
      dismissable={changing || q.length > 0}
      onDismiss={dismissSearch}
    >
      {results.length > 0
        ? results.map((sales) => (
            <CoworkerOption
              key={sales.openId}
              coworker={directoryById.get(sales.openId) ?? sales}
              selected={selectedSales?.openId === sales.openId}
              onSelect={handleSelect}
            />
          ))
        : pending
          ? (
              <div className="text-muted-foreground rounded-xl p-3 text-sm">Searching…</div>
            )
          : undefined}
    </SalesSearchPanel>
  );
}
