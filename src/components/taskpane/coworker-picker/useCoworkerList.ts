/* eslint-disable max-lines-per-function -- one cohesive hook: query state + debounced search effect + derived directory */
import { useEffect, useMemo, useReducer, useState } from "react";

import type { Coworker } from "../coworkers";
import { useCoworkerSearch } from "../../../hooks/useCoworkerSearch";
import {
  MIN_REMOTE_COWORKER_SEARCH_LENGTH,
  PREVIEW_COWORKERS,
  RECENTS_KEY,
  SEARCH_DEBOUNCE_MS,
} from "./constants";

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

export interface CoworkerListState {
  query: string;
  setQuery: (value: string) => void;
  results: Coworker[];
  directoryById: Map<string, Coworker>;
  searching: boolean;
  selectedCoworker?: Coworker;
  handleSelect: (coworker: Coworker) => void;
}

export function useCoworkerList({
  sessionId,
  userAccessToken,
  usePreviewCoworkers,
  selectedOpenId,
  onSelect,
}: {
  sessionId: string;
  userAccessToken?: string;
  usePreviewCoworkers: boolean;
  selectedOpenId?: string;
  onSelect: (coworker: Coworker) => void;
}): CoworkerListState {
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

  return { query, setQuery, results, directoryById, searching, selectedCoworker, handleSelect };
}
