import { ConnectCard } from "./ConnectCard";

export function LoginScreen({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <div
      className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8"
      style={{ backgroundColor: "var(--login-background)" }}
    >
      <header className="shrink-0 px-1">
        <div className="text-accent-foreground flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Outlook handoff
        </div>
      </header>
      <div className="flex flex-1 items-center py-7">
        <ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />
      </div>
    </div>
  );
}
