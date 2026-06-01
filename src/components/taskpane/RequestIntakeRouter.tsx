// Screen-routing for the Base Sync intake. RequestIntakeScreen stays an
// orchestration shell: it owns the reducer + effects + sync wiring and renders
// the build screen inline, while this resolver picks the non-build overlay
// (sync / received / error / auth-resolving / login). `null` means "no overlay
// screen — render the build shell".

import { AlertCircle, Loader2 } from "lucide-react";
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
      <header className="sync-enter shrink-0 px-1">
        <div className="text-accent-foreground flex items-center gap-2 text-[11px] font-semibold tracking-[0.01em] uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Outlook handoff
        </div>
        <p className="text-foreground/75 mt-2 max-w-[34ch] text-sm leading-relaxed text-pretty">
          Sign in once to route this message to Feishu Base and your team.
        </p>
      </header>
      <div className="intake-stagger flex flex-1 items-center py-7">
        <ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />
      </div>
    </div>
  );
}

function AuthResolvingScreen() {
  return (
    <div
      className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center"
      aria-busy="true"
      aria-label="Checking Feishu session"
    >
      <Loader2 className="text-muted-foreground size-6 animate-spin" aria-hidden="true" />
      <p className="text-muted-foreground text-sm text-pretty">Checking your Feishu session&hellip;</p>
    </div>
  );
}

function SyncErrorScreen({ message, onRetry, onBack }: { message: string; onRetry: () => void; onBack: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-8 text-center">
      <span className="sync-enter bg-destructive/10 text-destructive flex size-14 items-center justify-center rounded-2xl shadow-edge">
        <AlertCircle className="size-7" aria-hidden="true" />
      </span>
      <h1 className="sync-enter text-2xl text-balance" style={{ animationDelay: "70ms" }}>
        Sync failed
      </h1>
      <p
        className="sync-enter text-muted-foreground max-w-[34ch] text-sm leading-relaxed text-pretty"
        style={{ animationDelay: "140ms" }}
      >
        {message}
      </p>
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
