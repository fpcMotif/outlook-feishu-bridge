// Single source of truth for the Base Sync screen, keyed entirely on the real
// sync leg (`SyncPhase`). Before this, the screen told three different progress
// stories: the reducer's `syncPhase`, the eased meter, and a pair of numeric
// preview thresholds (>= 34 / >= 52) that happened to line up with the easing
// constants. Coupling the preview reveal to the easing internals meant any tweak
// to the meter silently shifted *when* the row/attachments appeared. Now every
// view decision — the meter's ceiling, the status copy, and the preview reveal —
// derives from the phase, so there is exactly one story. (ADR-0022 milestones.)

import type { SyncPhase } from "./intakeTypes";

export interface SyncPhaseView {
  /**
   * The percent the meter eases toward while on this leg (and snaps to on the
   * final beat). The meter never claims completion before the row exists.
   */
  ceiling: number;
  /** Italic status line under the meter. */
  label: string;
  /** Supporting detail copy. */
  detail: string;
  /** The Base row preview card has "landed" — solid, not translucent. */
  rowLanded: boolean;
  /** Preview attachments are settled in — full opacity, not dimmed. */
  attachmentsSettled: boolean;
}

// The preview reveals once the write begins (staging is the only real wait, and
// while it runs we have not committed a row yet, so the card stays provisional).
export const SYNC_PHASE_VIEW: Record<SyncPhase, SyncPhaseView> = {
  staging: {
    ceiling: 58,
    label: "Preparing your request",
    detail: "Reading the request and staging any attachments to Convex.",
    rowLanded: false,
    attachmentsSettled: false,
  },
  writing: {
    ceiling: 93,
    label: "Writing to Feishu Base",
    detail: "Creating the request row and backing it up in Convex.",
    rowLanded: true,
    attachmentsSettled: true,
  },
  finalizing: {
    ceiling: 100,
    label: "Synced",
    detail: "Row created — opening your request.",
    rowLanded: true,
    attachmentsSettled: true,
  },
};

export function syncPhaseView(phase: SyncPhase): SyncPhaseView {
  return SYNC_PHASE_VIEW[phase];
}
