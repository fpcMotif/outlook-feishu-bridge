import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";

interface CurrentRequestIdentity {
  userEmail?: string;
  conversationId?: string;
}

// Small interface over the public Base-sync actions so components depend on a
// hook (and tests can mock it). See convex/feishu/requestSync.ts, ADR-0012.
// Mount only while signed in (RequestIntakeSyncBridge) — do not pass a login
// gate prop; react-doctor treats that as prop-driven effect wiring.
export function useRequestSync(current?: CurrentRequestIdentity) {
  const sync = useAction(api.feishu.requestSync.syncRequest);
  const correct = useAction(api.feishu.requestSync.correctRequest);
  const existingSync = useQuery(
    api.emails.getBitableSyncByConversation,
    current?.userEmail && current?.conversationId
      ? { userEmail: current.userEmail, conversationId: current.conversationId }
      : "skip",
  );
  return { sync, correct, existingSync };
}
