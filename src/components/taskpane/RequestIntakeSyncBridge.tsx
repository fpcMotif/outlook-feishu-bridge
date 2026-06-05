import { useRequestSync } from "../../hooks/useRequestSync";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

// Convex existing-sync subscription only mounts after sign-in so react-doctor
// does not treat `enabled: isLoggedIn` as prop-driven effect wiring.
//
// The Bridge itself stays mounted across an email switch so the existing-sync
// subscription re-keys in place via the conversationId arg (verified safe: the
// snapshot fallback is conversation-keyed). `mailKey` is forwarded to scope the
// stateful Core draft to mailbox + conversation in a pinned pane. See ./mailKey.
export function RequestIntakeSyncBridge(props: RequestIntakeScreenProps & { mailKey: string }) {
  const { mailKey, ...screenProps } = props;
  const syncApi = useRequestSync({
    userEmail: props.mailItem.userEmail,
    conversationId: props.mailItem.conversationId,
    internetMessageId: props.mailItem.internetMessageId,
  });
  return (
    <RequestIntakeScreenCore
      key={mailKey}
      {...screenProps}
      mailKey={mailKey}
      syncApi={syncApi}
    />
  );
}
