import { useCallback, useRef, useState } from "react";

import { useOutsidePointerDismiss } from "./taskpaneOutsideDismiss";

const PANEL_EXIT_MS = 150;

export function useCustomerSearchSession() {
  const [searchSession, setSearchSession] = useState<{ openedAt: number } | null>(null);
  const [exiting, setExiting] = useState(false);
  const searchPanelBoundaryRef = useRef<HTMLElement>(null);

  const dismissSearch = useCallback(() => {
    setExiting(true);
    window.setTimeout(() => {
      setSearchSession(null);
      setExiting(false);
    }, PANEL_EXIT_MS);
  }, []);

  useOutsidePointerDismiss(
    searchPanelBoundaryRef,
    dismissSearch,
    Boolean(searchSession && !exiting),
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
    searchPanelBoundaryRef,
    openSearch,
    dismissSearch,
    closeSearch,
  };
}
