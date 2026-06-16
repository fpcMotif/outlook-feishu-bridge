import { ReceivedScreen } from "./ReceivedScreen";
import { resolveIntakeScreen } from "./RequestIntakeRouter";
import { SyncScreen } from "./SyncScreen";
import { RequestIntakeBuildPane } from "./RequestIntakeBuildPane";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";
import { useRequestIntakeScreen } from "./useRequestIntakeScreen";

type IntakeVm = ReturnType<typeof useRequestIntakeScreen>;

// The reactive attachment-fill status lives only on the authoritative query
// result (getBitableSyncByConversation), not on the localStorage snapshot used
// as the brief cold-open fallback. Pull it out of the union defensively — a
// snapshot (or null) reads as "no gate" until the live query resolves.
function liveAttachmentStatus(
  existingSync: IntakeVm["existingSync"],
): "pending" | "filling" | "filled" | "failed" | null {
  return existingSync && "attachmentStatus" in existingSync
    ? existingSync.attachmentStatus ?? null
    : null;
}

function resolveExistingSyncOverlay({
  existingSync,
  existingSyncStatus,
  screen,
  syncPreview,
}: Pick<IntakeVm, "existingSync" | "existingSyncStatus" | "syncPreview"> & {
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
        attachmentStatus={liveAttachmentStatus(existingSync)}
      />
    );
  }
  return existingSyncStatus === "pending" && screen === "build" ? (
    // Cold-open overlay for a server-side pending sync: we only know it's
    // pending, not which leg it reached, so show the conservative first phase
    // rather than implying the row is already being written.
    <SyncScreen preview={syncPreview} phase="staging" />
  ) : null;
}

export function RequestIntakeScreenCore(
  props: RequestIntakeScreenProps & { mailKey: string; syncApi: RequestIntakeSyncApi },
) {
  const vm = useRequestIntakeScreen(props);
  const {
    props: screenProps,
    state,
    syncPreview,
    selectedCount,
    existingSync,
    existingSyncStatus,
    runSync,
    dispatch,
  } = vm;
  const { isLoggedIn, isAuthLoading = false, onLogin, onLoginFallback } = screenProps;

  const overlay = resolveIntakeScreen({
    screen: state.screen,
    isLoggedIn,
    isAuthLoading,
    coworkerCount: selectedCount,
    syncError: state.syncError,
    bitableRecordId: state.bitableRecordId,
    bitableDetailUrl: state.bitableDetailUrl,
    attachmentStatus: liveAttachmentStatus(existingSync),
    syncPhase: state.syncPhase,
    syncPreview,
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
    syncPreview,
  });
  if (existingSyncOverlay) return existingSyncOverlay;

  return <RequestIntakeBuildPane vm={vm} />;
}
