import type { useRequestSync } from "../../hooks/useRequestSync";

export type RequestIntakeSyncApi = ReturnType<typeof useRequestSync>;

/** Logged-out shell: skip Convex lookup; submit path is gated elsewhere. */
export const loggedOutRequestIntakeSyncApi: RequestIntakeSyncApi = {
  sync: () => Promise.resolve({ status: "pending", recordId: null, detailUrl: null }),
  correct: () => Promise.resolve({ recordId: "", detailUrl: null }),
  existingSync: undefined,
};
