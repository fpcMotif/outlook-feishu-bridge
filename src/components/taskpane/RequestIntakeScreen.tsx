import { useRef } from "react";

import { RequestIntakeSyncBridge } from "./RequestIntakeSyncBridge";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import { loggedOutRequestIntakeSyncApi } from "./requestIntakeSyncApi";
import { deriveMailKey } from "./mailKey";
import { resetIntakeUploadCaches } from "./uploadIntakeFile";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

// Clear the module-level upload caches the instant the intake context
// (conversation) changes — synchronously during render, BEFORE the keyed child
// remounts and before any new-conversation upload can mint a storage id — so
// nothing from the previous conversation survives the switch. The ref-compare
// "reset on prop change" pattern is render-safe because resetIntakeUploadCaches
// is idempotent (StrictMode double-invoke is harmless).
//
// NOTE: this clears only the per-ID completedStorage/inFlight maps. It must NOT
// touch the per-conversation upload-draft cache (uploadDraftCache), which is keyed
// by openId+userEmail+conversationId and is the RESTORE source — wiring
// resetUploadDrafts() here would defeat restore-on-return entirely.
function useMailContextReset(mailKey: string): void {
  const previousKey = useRef(mailKey);
  if (previousKey.current !== mailKey) {
    previousKey.current = mailKey;
    resetIntakeUploadCaches();
  }
}

export function RequestIntakeScreen(props: RequestIntakeScreenProps) {
  // One key per conversation: switching threads remounts the intake tree (clean
  // slate); sibling messages in a thread keep it (in-progress request survives).
  const mailKey = deriveMailKey(props.mailItem);
  useMailContextReset(mailKey);

  if (props.isLoggedIn) {
    // Keep the Bridge mounted so its Convex existing-sync subscription re-keys
    // smoothly; it applies `key={mailKey}` to the Core underneath.
    return <RequestIntakeSyncBridge {...props} mailKey={mailKey} />;
  }
  return (
    <RequestIntakeScreenCore
      key={mailKey}
      {...props}
      syncApi={loggedOutRequestIntakeSyncApi}
    />
  );
}
