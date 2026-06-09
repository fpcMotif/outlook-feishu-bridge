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
    <div className="bg-background text-foreground no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8">
      <header className="shrink-0 px-1">
        <div className="text-muted-foreground flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Outlook handoff
        </div>
      </header>
      <div className="flex flex-1 items-center py-7">
        <ConnectCard
          onLogin={onLogin}
          onLoginFallback={onLoginFallback}
          isCheckingSession={isCheckingSession}
        />
      </div>
    </div>
  );
}
