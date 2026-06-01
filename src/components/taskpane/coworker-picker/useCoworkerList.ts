/* eslint-disable max-lines-per-function -- one cohesive hook: query state + debounced search effect + derived directory */
import { useEffect, useMemo, useReducer, useState } from "react";

import type { Coworker } from "../coworkers";
import { useCoworkerDirectory } from "../../../hooks/useCoworkerDirectory";
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

function normalizeCoworkerText(value: string): string {
  return value.trim().toLowerCase().replaceAll(/\s+/gu, " ");
}

function filterCoworkerDirectory(records: readonly Coworker[], query: string): Coworker[] {
  const normalized = normalizeCoworkerText(query);
  if (!normalized) return [];
  return records
    .filter((coworker) =>
      [coworker.name, coworker.openId]
        .map((value) => normalizeCoworkerText(value))
        .some((value) => value.includes(normalized)),
    )
    .slice(0, 50);
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
  const coworkerDirectory = useCoworkerDirectory(sessionId, !usePreviewCoworkers);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<Coworker[]>(loadRecents);
  const [results, dispatchResults] = useReducer(searchResultsReducer, []);

  const q = query.trim();
  const directoryResults = useMemo(
    () =>
      coworkerDirectory.state.status === "ready" && q.length >= MIN_REMOTE_COWORKER_SEARCH_LENGTH
        ? filterCoworkerDirectory(coworkerDirectory.state.records, q)
        : [],
    [coworkerDirectory.state.records, coworkerDirectory.state.status, q],
  );

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
    if (coworkerDirectory.state.status === "ready") {
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
  }, [coworkerDirectory.state.status, q, search, usePreviewCoworkers]);

  const displayedResults =
    coworkerDirectory.state.status === "ready" ? directoryResults : results;

  const directoryById = useMemo(() => {
    const map = new Map<string, Coworker>();
    const fixtureCoworkers = usePreviewCoworkers ? PREVIEW_COWORKERS : [];
    for (const c of [
      ...fixtureCoworkers,
      ...coworkerDirectory.state.records,
      ...recents,
      ...displayedResults,
    ]) {
      map.set(c.openId, c);
    }
    return map;
  }, [coworkerDirectory.state.records, displayedResults, recents, usePreviewCoworkers]);

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

  return { query, setQuery, results: displayedResults, directoryById, searching, selectedCoworker, handleSelect };
}
