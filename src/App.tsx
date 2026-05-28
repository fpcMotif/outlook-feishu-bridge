import { useEffect, useState } from "react";

import { useOffice } from "./office/useOffice";
import { TaskPane } from "./components/TaskPane";
import { DebugPanel } from "./components/DebugPanel";

// Debug panel is HIDDEN by default in every environment (dev, prod, ECS, CF).
// The only way to surface it is the Ctrl+Alt+D hotkey — pressing again hides
// it. URL flags and localStorage flags are intentionally NOT supported; the
// panel must never be visible to a user who didn't deliberately summon it.
function useDebugPanelToggle(): boolean {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey && e.altKey && (e.key === "d" || e.key === "D")) {
        e.preventDefault();
        setVisible((v) => !v);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  return visible;
}

export default function App() {
  const office = useOffice();
  const { isReady, host, error } = office;
  const showDebug = useDebugPanelToggle();

  let content;
  if (error) {
    content = (
      <div className="flex h-screen items-center justify-center p-4">
        <p className="text-destructive text-sm">{error}</p>
      </div>
    );
  } else if (isReady) {
    content = <TaskPane host={host} />;
  } else {
    content = (
      <div className="flex h-screen items-center justify-center p-4">
        <p className="text-muted-foreground text-sm">Loading Office Add-in&hellip;</p>
      </div>
    );
  }

  return (
    <>
      {content}
      {showDebug ? <DebugPanel office={office} /> : null}
    </>
  );
}
