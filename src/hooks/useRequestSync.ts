import { useCallback, useEffect, useMemo } from "react";
import { useAction, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import {
  clearRequestSyncSnapshot,
  readRequestSyncSnapshot,
  rememberRequestSyncSnapshot,
} from "./requestSyncSnapshot";

interface CurrentRequestIdentity {
  userEmail?: string;
  conversationId?: string;
  internetMessageId?: string;
}

function useCurrentRequestIdentity(current?: CurrentRequestIdentity) {
  return useMemo(
    () => ({
      userEmail: current?.userEmail,
      conversationId: current?.conversationId,
      internetMessageId: current?.internetMessageId,
    }),
    [current?.conversationId, current?.internetMessageId, current?.userEmail],
  );
}

function rememberSyncedResult(
  identity: CurrentRequestIdentity,
  result: {
    status: string;
    recordId?: string | null;
    detailUrl?: string | null;
  },
): boolean {
  if (result.status === "synced" && result.recordId) {
    rememberRequestSyncSnapshot(identity, result);
    return true;
  }
  return false;
}

// Cron-free self-heal: when this conversation's outbox row is stranded (action
// died, or the success-mark threw), the server marks it `rearmable`. Re-drive it
// once on the false→true edge — the action re-checks staleness and replays under
// the stored client_token, so a duplicate fire is harmless and it cannot loop.
function useRearmOnReopen(rearmable: boolean, identity: CurrentRequestIdentity) {
  const rearm = useAction(api.feishu.requestSync.rearmConversationSync);
  useEffect(() => {
    if (!rearmable) return;
    const { userEmail, conversationId } = identity;
    if (!userEmail || !conversationId) return;
    void rearm({ userEmail, conversationId });
  }, [rearmable, identity, rearm]);
}

// Small interface over the public Base-sync actions so components depend on a
// hook (and tests can mock it). See convex/feishu/requestSync.ts, ADR-0012.
// Mount only while signed in (RequestIntakeSyncBridge) — do not pass a login
// gate prop; react-doctor treats that as prop-driven effect wiring.
export function useRequestSync(current?: CurrentRequestIdentity) {
  const syncAction = useAction(api.feishu.requestSync.syncRequest);
  const correct = useAction(api.feishu.requestSync.correctRequest);
  const currentIdentity = useCurrentRequestIdentity(current);
  const cachedExistingSync = useMemo(
    () => readRequestSyncSnapshot(currentIdentity),
    [currentIdentity],
  );
  const authoritativeExistingSync = useQuery(
    api.emails.getBitableSyncByConversation,
    current?.userEmail && current?.conversationId
      ? { userEmail: current.userEmail, conversationId: current.conversationId }
      : "skip",
  );

  useEffect(() => {
    if (authoritativeExistingSync === undefined) return;
    if (
      authoritativeExistingSync !== null &&
      rememberSyncedResult(currentIdentity, authoritativeExistingSync)
    ) {
      return;
    }
    clearRequestSyncSnapshot(currentIdentity);
  }, [authoritativeExistingSync, currentIdentity]);

  useRearmOnReopen(authoritativeExistingSync?.rearmable === true, currentIdentity);

  const sync = useCallback(
    async (args: Parameters<typeof syncAction>[0]) => {
      const result = await syncAction(args);
      rememberSyncedResult(
        {
          userEmail: args.userEmail,
          conversationId: args.conversationId,
          internetMessageId: args.internetMessageId,
        },
        result,
      );
      return result;
    },
    [syncAction],
  );

  const existingSync =
    authoritativeExistingSync === undefined ? cachedExistingSync : authoritativeExistingSync;
  return { sync, correct, existingSync };
}
