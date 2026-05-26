import { useOffice } from "./office/useOffice";
import { TaskPane } from "./components/TaskPane";
import { DebugPanel } from "./components/DebugPanel";

export default function App() {
  const office = useOffice();
  const { isReady, host, error } = office;

  let content;
  if (error) {
    content = (
      <div className="flex h-screen items-center justify-center p-4">
        <p className="text-red-600 text-sm">{error}</p>
      </div>
    );
  } else if (isReady) {
    content = <TaskPane host={host} />;
  } else {
    content = (
      <div className="flex h-screen items-center justify-center p-4">
        <p className="text-gray-500 text-sm">Loading Office Add-in...</p>
      </div>
    );
  }

  return (
    <>
      {content}
      <DebugPanel office={office} />
    </>
  );
}
