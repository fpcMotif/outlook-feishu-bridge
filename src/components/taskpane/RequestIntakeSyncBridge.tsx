import { useRequestSync } from "../../hooks/useRequestSync";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

// Convex existing-sync subscription only mounts after sign-in so react-doctor
// does not treat `enabled: isLoggedIn` as prop-driven effect wiring.
export function RequestIntakeSyncBridge(props: RequestIntakeScreenProps) {
  const syncApi = useRequestSync({
    userEmail: props.mailItem.userEmail,
    conversationId: props.mailItem.conversationId,
  });
  return <RequestIntakeScreenCore {...props} syncApi={syncApi} />;
}
