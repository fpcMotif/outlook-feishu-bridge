/**
 * Submit dock enablement for RequestIntakeScreen → SubmitDock.
 *
 * **Fulfilled request:** non-empty trimmed note on at least one request id. The
 * current request-note UI writes into the primary request id; `buildFilledRequests`
 * still accepts any populated request id.
 *
 * **Live sync button** requires all three: customer selected, exactly one
 * coworker selected, and ≥1 fulfilled request.
 *
 * ```mermaid
 * flowchart TD
 *   A[Dock] --> B{customer?}
 *   B -->|no| H1["Hint: Select a customer"]
 *   B -->|yes| C{coworker?}
 *   C -->|no| H2["Hint: Choose exactly one Feishu coworker"]
 *   C -->|yes| D{request note?}
 *   D -->|no| H3["Hint: Start a request below"]
 *   D -->|yes| L["Live: Sync with coworker"]
 * ```
 *
 * ```mermaid
 * stateDiagram-v2
 *   direction LR
 *   [*] --> Disabled
 *   state Disabled {
 *     [*] --> CheckCustomer
 *     CheckCustomer --> HintNoCustomer: no customer
 *     CheckCustomer --> CheckCoworker: customer ok
 *     CheckCoworker --> HintNoCoworker: no coworker
 *     CheckCoworker --> CheckRequest: coworker ok
 *     CheckRequest --> HintNoRequest: count = 0
 *   }
 *   Disabled --> Live: customer ∧ coworker ∧ fulfilled ≥ 1
 *   Live --> Disabled: any requirement cleared
 *   Live --> Submitting: tap Sync
 *   Submitting --> Live: send idle (build screen keeps dock hidden during overlay)
 * ```
 *
 * @see docs/submit-dock-sync-gate.md
 */

import { REQUESTS } from "./requests";
import { isPreviewCoworkerOpenId } from "../../testing/preview-coworkers";

export function buildFilledRequests(notes: Record<string, string>) {
  return REQUESTS.flatMap((r) => {
    const note = (notes[r.id] ?? "").trim();
    return note ? [{ id: r.id, title: r.title, note }] : [];
  });
}

export type SubmitSyncGateInput = {
  hasCustomer: boolean;
  hasCoworker: boolean;
  /** Number of request types with a non-empty trimmed note. */
  fulfilledRequestCount: number;
  /** True while selected user-uploaded files are still staging to Convex. */
  hasPendingSelectedUploads?: boolean;
  /** Browser dev host (TaskPane devPreview) — blocks preview fixture coworkers. */
  devPreview?: boolean;
  selectedCoworkerOpenId?: string | null;
};

export function canSubmitSync({
  hasCustomer,
  hasCoworker,
  fulfilledRequestCount,
  hasPendingSelectedUploads = false,
  devPreview = false,
  selectedCoworkerOpenId,
}: SubmitSyncGateInput): boolean {
  if (devPreview && isPreviewCoworkerOpenId(selectedCoworkerOpenId)) {
    return false;
  }
  return (
    hasCustomer &&
    hasCoworker &&
    fulfilledRequestCount > 0 &&
    !hasPendingSelectedUploads
  );
}

/** Hint for the disabled dock button; first missing requirement wins (top-to-bottom on screen). */
export function submitSyncHint(input: SubmitSyncGateInput): string {
  if (input.devPreview && isPreviewCoworkerOpenId(input.selectedCoworkerOpenId)) {
    return "Pick a real Feishu colleague (preview fixtures cannot sync to Base)";
  }
  if (!input.hasCustomer) {
    return "Select a customer";
  }
  if (!input.hasCoworker) {
    return "Choose exactly one Feishu coworker";
  }
  if (input.fulfilledRequestCount === 0) {
    return "Start a request below";
  }
  if (inputHasPendingUploads(input)) {
    return "Wait for file uploads";
  }
  return "Ready to sync";
}

function inputHasPendingUploads(input: Pick<SubmitSyncGateInput, "hasPendingSelectedUploads">): boolean {
  return input.hasPendingSelectedUploads === true;
}
