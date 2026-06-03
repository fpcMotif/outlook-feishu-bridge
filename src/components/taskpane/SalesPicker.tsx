/* eslint-disable max-lines-per-function */
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { Briefcase } from "lucide-react";

import { CoworkerOption } from "./CoworkerPicker";
import type { Coworker } from "./coworkers";
import { useCoworkerSearch } from "../../hooks/useCoworkerSearch";
import { TaskpaneSearchDropdown } from "./TaskpaneSearchDropdown";
import { TaskpaneSelectionRow } from "./TaskpaneSelectionRow";
import {
  TASKPANE_SEARCH_PANEL_HEADER,
  TASKPANE_SEARCH_PANEL_SHELL_HEADER,
  TASKPANE_SEARCH_PANEL_TITLE,
} from "./taskpaneSearchPanelLayout";

const PREVIEW_SALES: Coworker[] = [
  { openId: "ou_jenny", name: "Jenny Xu" },
  { openId: "ou_michael", name: "Michael Chen" },
];

const RECENTS_KEY = "feishu_recent_sales";
const SEARCH_DEBOUNCE_MS = 250;

const SALES_FALLBACK_ICON = (
  <Briefcase className="size-4 translate-y-px" strokeWidth={2} />
);

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

  useEffect(() => {
    if (!dismissable || !onDismiss) return;
    const dismiss = onDismiss;
    function onPointer(event: MouseEvent) {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        dismiss();
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [dismissable, onDismiss]);

  return (
    <div
      ref={panelRef}
      className={TASKPANE_SEARCH_PANEL_SHELL_HEADER}
      aria-labelledby="sales-search-title"
    >
      <div className={TASKPANE_SEARCH_PANEL_HEADER}>
        <span id="sales-search-title" className={TASKPANE_SEARCH_PANEL_TITLE}>
          Pick sales
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
  selectedSales,
  onSelect,
  usePreviewCoworkers = false,
}: {
  sessionId: string;
  userAccessToken?: string;
  selectedSales: Coworker | null;
  onSelect: (sales: Coworker) => void;
  usePreviewCoworkers?: boolean;
}) {
  const search = useCoworkerSearch(sessionId, userAccessToken);
  const [query, setQuery] = useState("");
  const [changing, setChanging] = useState(false);
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);

  const q = query.trim();

  useEffect(() => {
    if (!q) {
      dispatchResults([]);
      return;
    }
    const previewMatches = PREVIEW_SALES.filter((c) =>
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

  if (!showSearch) {
    return (
      <TaskpaneSelectionRow
        dataRow="sales"
        icon={SALES_FALLBACK_ICON}
        label={selectedSales.name}
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
        : null}
    </SalesSearchPanel>
  );
}
