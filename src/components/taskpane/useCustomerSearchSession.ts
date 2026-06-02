import { useCallback, useRef, useState, type RefObject } from "react";

import { useTaskpaneCardBoundary } from "./taskpaneCardBoundary";
import { useOutsidePointerDismiss } from "./taskpaneOutsideDismiss";

const PANEL_EXIT_MS = 150;

export function useCustomerSearchSession(embedded: boolean) {
  const [searchSession, setSearchSession] = useState<{ openedAt: number } | null>(null);
  const [exiting, setExiting] = useState(false);
  const cardBoundary = useTaskpaneCardBoundary();
  const standaloneBoundaryRef = useRef<HTMLElement>(null);
  const dismissBoundaryRef = embedded ? cardBoundary : standaloneBoundaryRef;

  const dismissSearch = useCallback(() => {
    setExiting(true);
    window.setTimeout(() => {
      setSearchSession(null);
      setExiting(false);
    }, PANEL_EXIT_MS);
  }, []);

  useOutsidePointerDismiss(
    dismissBoundaryRef ?? standaloneBoundaryRef,
    dismissSearch,
    Boolean(searchSession && !exiting && dismissBoundaryRef),
  );

  const openSearch = () => {
    setExiting(false);
    setSearchSession({ openedAt: performance.now() });
  };

  const closeSearch = () => {
    setSearchSession(null);
    setExiting(false);
  };

  return {
    searchSession,
    exiting,
    standaloneBoundaryRef,
    openSearch,
    dismissSearch,
    closeSearch,
  };
}

export function customerSearchBoundaryRef(
  embedded: boolean,
  standaloneBoundaryRef: RefObject<HTMLElement | null>,
): RefObject<HTMLElement | null> | undefined {
  return embedded ? undefined : standaloneBoundaryRef;
}
