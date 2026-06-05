import { ReceivedScreen } from "./ReceivedScreen";
import { resolveIntakeScreen } from "./RequestIntakeRouter";
import { RequestIntakeBuildPane } from "./RequestIntakeBuildPane";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";
import { useRequestIntakeScreen } from "./useRequestIntakeScreen";

type IntakeVm = ReturnType<typeof useRequestIntakeScreen>;

function resolveExistingSyncOverlay({
  existingSync,
  existingSyncStatus,
  screen,
}: Pick<IntakeVm, "existingSync" | "existingSyncStatus"> & {
  screen: IntakeVm["state"]["screen"];
}) {
  if (existingSyncStatus === "synced" && existingSync?.recordId && screen === "build") {
    return (
      <ReceivedScreen
        coworkerCount={existingSync.coworkerCount ?? 1}
        recordId={existingSync.recordId}
        detailUrl={existingSync.detailUrl}
        submittedAt={existingSync.syncedAt}
        alreadySynced={true}
      />
    );
  }
  if (existingSyncStatus === "pending" && screen === "build") {
    return (
      <ReceivedScreen
        coworkerCount={existingSync?.coworkerCount ?? 1}
        recordId={null}
        detailUrl={null}
        submittedAt={existingSync?.syncedAt}
      />
    );
  }
  return null;
}

export function RequestIntakeScreenCore(props: RequestIntakeScreenProps & { syncApi: RequestIntakeSyncApi }) {
  const vm = useRequestIntakeScreen(props);
  const {
    props: screenProps,
    state,
    syncPreview,
    selectedCount,
    existingSync,
    existingSyncStatus,
    fireSelfForward,
    runSync,
    dispatch,
  } = vm;
  const { isLoggedIn, isAuthLoading = false, onLogin, onLoginFallback } = screenProps;

  const overlay = resolveIntakeScreen({
    screen: state.screen,
    isLoggedIn,
    isAuthLoading,
    coworkerCount: selectedCount,
    selfForwardStatus: state.selfForwardStatus,
    syncError: state.syncError,
    bitableRecordId: state.bitableRecordId,
    bitableDetailUrl: state.bitableDetailUrl,
    syncPreview,
    onRetrySelfForward: fireSelfForward,
    onRetrySync: runSync,
    onBackToBuild: () => dispatch({ type: "screenChanged", screen: "build" }),
    onLogin,
    onLoginFallback,
  });
  if (overlay) return overlay;
  const existingSyncOverlay = resolveExistingSyncOverlay({
    existingSync,
    existingSyncStatus,
    screen: state.screen,
  });
  if (existingSyncOverlay) return existingSyncOverlay;

  return <RequestIntakeBuildPane vm={vm} />;
}
