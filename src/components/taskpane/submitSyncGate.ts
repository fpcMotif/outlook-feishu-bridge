/**
 * Submit dock enablement for RequestIntakeScreen → SubmitDock.
 *
 * **Fulfilled request:** non-empty trimmed note on at least one request id. The
 * current request-note UI writes into the primary request id; `buildFilledRequests`
 * still accepts any populated request id.
 *
 * **Live sync button** requires all three content prerequisites — customer
 * selected, exactly one coworker selected, and ≥1 fulfilled request — AND that
 * no selected upload is still in flight. While a staged upload is pending/
 * uploading the dock stays grayed so submit can't race ahead and sync the row
 * with an empty Sales Files cell; the way out is letting every upload finish.
 *
 * A FAILED upload is *parked*, not blocking: it has no bytes staged, so it is
 * never part of the selection (occupiesSlot is false for status "error") and the
 * dock stays live — Sync proceeds WITHOUT the failed files (they are surfaced
 * inline so the user can Retry or remove them, but they never trap submit). This
 * revises the original ADR-0027 "retry or remove to continue" rule.
 *
 * ```mermaid
 * flowchart TD
 *   A[Dock] --> B{customer?}
 *   B -->|no| H1["Hint: Select a customer"]
 *   B -->|yes| C{coworker?}
 *   C -->|no| H2["Hint: Choose exactly one Feishu coworker"]
 *   C -->|yes| D{request note?}
 *   D -->|no| H3["Hint: Start a request below"]
 *   D -->|yes| E{any upload in flight?}
 *   E -->|in flight| H4["Hint: Waiting for attachments to finish uploading"]
 *   E -->|none in flight| L["Live: Sync with coworker (failed picks parked, synced without)"]
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
 *     CheckRequest --> CheckUploads: count ≥ 1
 *     CheckUploads --> HintUploading: upload in flight
 *   }
 *   Disabled --> Live: customer ∧ coworker ∧ fulfilled ≥ 1 ∧ none in flight
 *   Live --> Disabled: any requirement cleared or a new upload starts
 *   Live --> Submitting: tap Sync
 *   Submitting --> Live: send idle (build screen keeps dock hidden during overlay)
 * ```
 *
 * @see docs/submit-dock-sync-gate.md
 */

import { REQUESTS } from "./requests";
import { isPreviewCoworkerOpenId } from "../../testing/preview-coworkers";
import type { UploadedFile } from "./intakeTypes";

export function buildFilledRequests(notes: Record<string, string>) {
  return REQUESTS.flatMap((r) => {
    const note = (notes[r.id] ?? "").trim();
    return note ? [{ id: r.id, title: r.title, note }] : [];
  });
}

export type UploadGateState = {
  /** A selected, valid upload is still pending / uploading / processing. */
  uploadsInFlight: boolean;
  /**
   * A selected, valid upload finished in error. PARKED, not blocking: it is no
   * longer part of the selection, so Sync stays live and proceeds without it —
   * the count is surfaced inline so the user can Retry or remove it.
   */
  uploadsParked: boolean;
};

/**
 * Reduce the staged uploads to the booleans the submit gate cares about. Only
 * uploads the user kept checked AND that passed validation are considered
 * (rejected or deselected rows are shown but never sent). A valid row whose
 * status is anything but `complete`/`error` — or not set yet — counts as in
 * flight: the dock must stay grayed until the byte upload to Convex resolves,
 * otherwise submit stages an empty Sales Files cell. A failed row is parked
 * (informational) and does NOT gate the dock — Sync syncs without it.
 */
export function uploadGateState(uploadedFiles: UploadedFile[]): UploadGateState {
  let uploadsInFlight = false;
  let uploadsParked = false;
  for (const u of uploadedFiles) {
    if (u.rejection !== null || !u.selected) continue;
    if (u.status === "complete") continue;
    if (u.status === "error") uploadsParked = true;
    else uploadsInFlight = true;
  }
  return { uploadsInFlight, uploadsParked };
}

export type SubmitSyncGateInput = {
  hasCustomer: boolean;
  hasCoworker: boolean;
  /** Number of request types with a non-empty trimmed note. */
  fulfilledRequestCount: number;
  /** Browser dev host (TaskPane devPreview) — blocks preview fixture coworkers. */
  devPreview?: boolean;
  selectedCoworkerOpenId?: string | null;
  /** A selected upload is still pending/uploading — keep the dock grayed. */
  uploadsInFlight?: boolean;
  /**
   * A selected upload failed — parked, NOT blocking. Sync proceeds without it;
   * carried only so the hint can mention the skip. Never gates the dock.
   */
  uploadsParked?: boolean;
};

export function canSubmitSync({
  hasCustomer,
  hasCoworker,
  fulfilledRequestCount,
  devPreview = false,
  selectedCoworkerOpenId,
  uploadsInFlight = false,
}: SubmitSyncGateInput): boolean {
  if (devPreview && isPreviewCoworkerOpenId(selectedCoworkerOpenId)) {
    return false;
  }
  // A failed upload no longer blocks: it is parked out of the selection and
  // synced-without. Only an in-flight upload keeps the dock grayed.
  if (uploadsInFlight) {
    return false;
  }
  return hasCustomer && hasCoworker && fulfilledRequestCount > 0;
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
  if (input.uploadsInFlight) {
    return "Waiting for attachments to finish uploading";
  }
  // A parked (failed) upload does not gate the dock, so it never produces a
  // blocking hint — Sync stays live and skips it. The inline attachment notice
  // carries the "failed, will be skipped" messaging instead.
  return "Ready to sync";
}
