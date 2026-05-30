// Screen-routing for the Base Sync intake. RequestIntakeScreen stays an
// orchestration shell: it owns the reducer + effects + sync wiring and renders
// the build screen inline, while this resolver picks the non-build overlay
// (sync / received / error / auth-resolving / login). `null` means "no overlay
// screen — render the build shell".

import { Loader2 } from "lucide-react";
import type { ReactNode } from "react";

import type { IntakeScreenName, SelfForwardStatus } from "./intakeReducer";
import { Button } from "../ui/button";
import { ConnectCard } from "./ConnectCard";
import { ReceivedScreen } from "./ReceivedScreen";
import { SyncScreen } from "./SyncScreen";

function LoginScreen({
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

function AuthResolvingScreen() {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-label="Checking Feishu session" />
    </div>
  );
}

function SyncErrorScreen({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <h1 className="text-2xl">Sync failed</h1>
      <p className="text-muted-foreground max-w-[34ch] text-sm leading-relaxed">{message}</p>
      <div className="flex gap-2">
        <Button onClick={onRetry}>Try again</Button>
        <Button variant="secondary" onClick={onBack}>
          Back
        </Button>
      </div>
    </div>
  );
}

export interface IntakeRouterProps {
  screen: IntakeScreenName;
  isLoggedIn: boolean;
  isAuthLoading: boolean;
  coworkerCount: number;
  selfForwardStatus: SelfForwardStatus;
  syncError: string | null;
  clientEmail: string;
  filledRequests: { id: string; title: string; note: string }[];
  onRetrySelfForward: () => void;
  onRetrySync: () => void;
  onBackToBuild: () => void;
  onLogin: () => void;
  onLoginFallback: () => void;
}

// Resolve the overlay screen for the current intake state. Returns `null` when
// the build shell should render. A plain resolver (not a component) so the
// parent can branch on a real `null`; it holds no hooks, so direct calls are
// safe. Branch order is load-bearing: received -> sync -> error -> login gate.
export function resolveIntakeScreen(props: IntakeRouterProps): ReactNode | null {
  const { screen, isLoggedIn, isAuthLoading } = props;
  if (screen === "received") {
    return (
      <ReceivedScreen
        coworkerCount={props.coworkerCount}
        selfForwardStatus={props.selfForwardStatus}
        onRetrySelfForward={props.onRetrySelfForward}
      />
    );
  }
  if (screen === "sync") {
    return (
      <SyncScreen requests={props.filledRequests} clientEmail={props.clientEmail} coworkerCount={props.coworkerCount} />
    );
  }
  if (screen === "error") {
    return (
      <SyncErrorScreen
        message={props.syncError ?? "Could not sync to Feishu Base."}
        onRetry={props.onRetrySync}
        onBack={props.onBackToBuild}
      />
    );
  }
  if (!isLoggedIn) {
    if (isAuthLoading) return <AuthResolvingScreen />;
    return <LoginScreen onLogin={props.onLogin} onLoginFallback={props.onLoginFallback} />;
  }
  return null;
}
