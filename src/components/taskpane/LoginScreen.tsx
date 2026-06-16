import { TaskpaneEyebrow, TaskpaneScrollShell } from "@/design-system/taskpane";

import { ConnectCard } from "./ConnectCard";

export function LoginScreen({
  onLogin,
  onLoginFallback,
  isCheckingSession = false,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
  isCheckingSession?: boolean;
}) {
  return (
    <TaskpaneScrollShell>
      <header className="shrink-0 px-1">
        <TaskpaneEyebrow>Outlook handoff</TaskpaneEyebrow>
      </header>
      <div className="flex flex-1 items-center py-7">
        <ConnectCard
          onLogin={onLogin}
          onLoginFallback={onLoginFallback}
          isCheckingSession={isCheckingSession}
        />
      </div>
    </TaskpaneScrollShell>
  );
}
