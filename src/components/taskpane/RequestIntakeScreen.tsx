import { RequestIntakeSyncBridge } from "./RequestIntakeSyncBridge";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import { loggedOutRequestIntakeSyncApi } from "./requestIntakeSyncApi";
import { deriveMailKey } from "./mailKey";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export function RequestIntakeScreen(props: RequestIntakeScreenProps) {
  // Pinned-pane support: key by mailbox + conversation so switching feels like
  // flipping pages: new conversations start fresh, returning conversations restore.
  const mailKey = deriveMailKey(props.mailItem);
  if (props.isLoggedIn) {
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
