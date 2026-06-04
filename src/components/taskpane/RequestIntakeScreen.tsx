import { RequestIntakeSyncBridge } from "./RequestIntakeSyncBridge";
import { RequestIntakeScreenCore } from "./RequestIntakeScreenCore";
import { loggedOutRequestIntakeSyncApi } from "./requestIntakeSyncApi";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";

export function RequestIntakeScreen(props: RequestIntakeScreenProps) {
  if (props.isLoggedIn) {
    return <RequestIntakeSyncBridge {...props} />;
  }
  return <RequestIntakeScreenCore {...props} syncApi={loggedOutRequestIntakeSyncApi} />;
}
