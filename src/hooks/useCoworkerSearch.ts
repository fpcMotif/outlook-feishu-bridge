import { useCallback } from "react";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Contact } from "@/forward/targets";

// Real Feishu directory search (Search Users, scope contact:user:search, user
// token). The sessionId scopes the user token. See convex/feishu/contacts.ts +
// ADR-0003. Returns [] for a blank query.
export function useCoworkerSearch(sessionId: string, userAccessToken?: string) {
  const searchAction = useAction(api.feishu.contacts.searchContacts);
  return useCallback(
    async (query: string): Promise<Contact[]> => {
      const q = query.trim();
      if (!q) return [];
      return await searchAction({ sessionId, query: q, userAccessToken });
    },
    [searchAction, sessionId, userAccessToken],
  );
}
