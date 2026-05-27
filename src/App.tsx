import { useOffice } from "./office/useOffice";
import { TaskPane } from "./components/TaskPane";
import { DebugPanel } from "./components/DebugPanel";

function showDebugPanel() {
  if (!import.meta.env.DEV) return false;
  const params = new URLSearchParams(window.location.search);
  if (params.has("debug")) return true;
  try {
    return localStorage.getItem("feishu_debug") === "1";
  } catch {
    return false;
  }
}

export default function App() {
  const office = useOffice();
  const { isReady, host, error } = office;

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
        <p className="text-muted-foreground text-sm">Loading Office Add-in...</p>
      </div>
    );
  }

  return (
    <>
      {content}
      {showDebugPanel() ? <DebugPanel office={office} /> : null}
    </>
  );
}
