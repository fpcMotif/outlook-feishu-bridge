import { useEffect, useMemo, useReducer, useState } from "react";
import type { Coworker } from "../coworkers";
import { useCoworkerSearch } from "../../../hooks/useCoworkerSearch";
import { PREVIEW_COWORKERS, RECENTS_KEY } from "./constants";

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

function useCoworkerSearchEffect(
  q: string,
  search: (query: string) => Promise<Coworker[]>,
  dispatchResults: React.Dispatch<Coworker[]>,
) {
  useEffect(() => {
    if (!q) {
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
          if (!cancelled) {
            dispatchResults(
              PREVIEW_COWORKERS.filter((c) => c.name.toLowerCase().includes(q.toLowerCase())),
            );
          }
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, search, dispatchResults]);
}

export function useCoworkerList(sessionId: string, userAccessToken?: string) {
  const search = useCoworkerSearch(sessionId, userAccessToken);
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);

  const q = query.trim();

  useCoworkerSearchEffect(q, search, dispatchResults);

  const directoryById = useMemo(() => {
    const map = new Map<string, Coworker>();
    for (const c of [...PREVIEW_COWORKERS, ...recents, ...results]) map.set(c.openId, c);
    return map;
  }, [recents, results]);

  const searching = q.length > 0;
  const suggested = PREVIEW_COWORKERS.slice(0, 4).filter(
    (coworker) => !recents.some((recent) => recent.openId === coworker.openId),
  );
  const list = searching ? results : [...recents, ...suggested].slice(0, 6);
  const listLabel = searching ? "Results" : recents.length > 0 ? "Recent & suggested" : "Suggested";

  const handleSelect = (coworker: Coworker, onSelect: (coworker: Coworker) => void) => {
    const next = [coworker, ...loadRecents().filter((c) => c.openId !== coworker.openId)].slice(0, 6);
    try {
      localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
    } catch {
      /* ignore quota / unavailable storage */
    }
    setRecents(next);
    onSelect(coworker);
  };

  return {
    query,
    setQuery,
    focused,
    setFocused,
    list,
    listLabel,
    searching,
    directoryById,
    handleSelect,
  };
}
