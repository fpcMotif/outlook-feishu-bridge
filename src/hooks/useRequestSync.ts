import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";

// Small interface over the public Bitable-sync actions so components depend on a
// hook (and tests can mock it). See convex/feishu/requestSync.ts, ADR-0012.
export function useRequestSync() {
  const sync = useAction(api.feishu.requestSync.syncRequest);
  const correct = useAction(api.feishu.requestSync.correctRequest);
  return { sync, correct };
}
