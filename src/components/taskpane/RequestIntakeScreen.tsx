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
// touch the per-conversation draft caches, which are keyed by account + mailbox
// + conversation and are the RESTORE source — wiring their reset here would
// defeat restore-on-return entirely.
function useMailContextReset(mailKey: string): void {
  const previousKey = useRef(mailKey);
  if (previousKey.current !== mailKey) {
    previousKey.current = mailKey;
    resetIntakeUploadCaches();
  }
}

export function RequestIntakeScreen(props: RequestIntakeScreenProps) {
  // One key per mailbox conversation: switching threads remounts the intake tree
  // (new page); sibling messages in a thread keep it. Returning to a previous
  // conversation restores that page from the intake draft cache.
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
      mailKey={mailKey}
      syncApi={loggedOutRequestIntakeSyncApi}
    />
  );
}
