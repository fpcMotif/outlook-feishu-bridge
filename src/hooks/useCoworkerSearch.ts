import { useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Coworker } from "../components/taskpane/coworkers";

// Real Feishu directory search (Search Users, scope contact:user:search, user
// token). The sessionId scopes the user token. See convex/feishu/coworkers.ts +
// ADR-0003. Returns [] for a blank query.
export function useCoworkerSearch(sessionId: string, userAccessToken?: string) {
  const searchAction = useAction(api.feishu.coworkers.searchCoworkers);
  return useCallback(
    async (query: string): Promise<Coworker[]> => {
      const q = query.trim();
      if (!q) return [];
      return await searchAction({ sessionId, query: q, userAccessToken });
    },
    [searchAction, sessionId, userAccessToken],
  );
}
