// Screen-routing for the Base Sync intake. RequestIntakeScreen stays an
// orchestration shell: it owns the reducer + effects + sync wiring and renders
// the build screen inline, while this resolver picks the non-build overlay
// (sync / received / error / auth-resolving / login). `null` means "no overlay
// screen — render the build shell".

import type { ReactNode } from "react";

import type { IntakeScreenName, SelfForwardStatus } from "./intakeReducer";
import { ReceivedScreen } from "./ReceivedScreen";
import { SyncScreen } from "./SyncScreen";
import { AuthResolvingScreen } from "./AuthResolvingScreen";
import { LoginScreen } from "./LoginScreen";
import { SyncErrorScreen } from "./SyncErrorScreen";

export interface IntakeRouterProps {
  screen: IntakeScreenName;
  isLoggedIn: boolean;
  isAuthLoading: boolean;
  coworkerCount: number;
  selfForwardStatus: SelfForwardStatus;
  syncError: string | null;
  bitableRecordId: string | null;
  bitableDetailUrl: string | null;
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
        recordId={props.bitableRecordId}
        detailUrl={props.bitableDetailUrl}
        selfForwardStatus={props.selfForwardStatus}
        onRetrySelfForward={props.onRetrySelfForward}
      />
    );
  }
  if (screen === "sync") {
    return (
      <SyncScreen requests={props.filledRequests} />
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
