import { useRef } from "react";

import { RequestIntakeSyncBridge } from "./RequestIntakeSyncBridge";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import { loggedOutRequestIntakeSyncApi } from "./requestIntakeSyncApi";
import { deriveMailKey } from "./mailKey";
import { resetIntakeStagingForMailSwitch } from "./intakeSessionState";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

// Reset the per-upload-id staging the instant the intake context (conversation)
// changes — synchronously during render, BEFORE the keyed child remounts and
// before any new-conversation upload can mint a storage id. The ref-compare
// "reset on prop change" pattern is render-safe because the reset is idempotent
// (StrictMode double-invoke is harmless). intakeSessionState owns the lifecycle
// rules — in particular that this must NEVER touch the draft caches (the
// restore-on-return source).
function useMailContextReset(mailKey: string): void {
  const previousKey = useRef(mailKey);
  if (previousKey.current !== mailKey) {
    previousKey.current = mailKey;
    resetIntakeStagingForMailSwitch();
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
