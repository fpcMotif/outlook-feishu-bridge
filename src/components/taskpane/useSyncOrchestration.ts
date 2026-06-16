/* eslint-disable max-lines-per-function -- cohesive sync pipeline (generation guards + phased promise chain). */
import { useCallback, useEffect, useRef } from "react";

import type { Dispatch } from "react";

import { dlog, dtime } from "../../debug";
import { buildSyncPayload } from "./buildSyncPayload";
import { clearIntakeDraft } from "./intakeDraftCache";
import { clearUploadDraft } from "./uploadDraftCache";
import type { IntakeAction, IntakeState } from "./intakeTypes";
import type { RequestIntakeScreenProps } from "./requestIntakeScreenProps";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";
import type { AttachmentSyncResult } from "./useAttachmentSync";

// How long the meter rests at 100% before handing off to the Received screen —
// a short, honest "done" beat so a fast sync completes visibly instead of
// snapping away mid-climb. Kept brief so the scene never feels slow.
const SYNC_COMPLETION_HOLD_MS = 280;

export interface SyncOrchestration {
  /** Run the full submit pipeline: stage → write row → finalize → succeed. */
  runSync: () => Promise<void>;
  /** Reconcile against the authoritative `getBitableSyncByConversation` result. */
  applyExistingSyncUpdate: () => void;
  /**
   * Set once a successful sync (local or authoritative) has consumed this
   * conversation's staged blobs, so the unmount snapshot drops the dead draft
   * instead of resurrecting pointers to deleted storage. Owned here because the
   * pipeline is what makes the draft dead; the screen reads it on unmount.
   */
  draftClearedRef: React.MutableRefObject<boolean>;
}

/**
 * The Base Sync pipeline, lifted out of useRequestIntakeScreen so the hook stays
 * an assembly point rather than an orchestration monolith. Owns the sync
 * generation guards (so a stale in-flight sync can never repaint over a newer
 * one), advances `syncPhase` as each real milestone lands — staging → writing →
 * finalizing — which drives the SyncScreen meter, and stamps the click→synced
 * latency span across both the dedup fast path and the fresh authoritative path
 * (ADR-0027).
 */
export function useSyncOrchestration({
  dispatch,
  sync,
  stageSelected,
  mailItem,
  state,
  user,
  requestNote,
  uploadDraftKey,
  intakeDraftKey,
  existingSync,
  existingSyncStatus,
}: {
  dispatch: Dispatch<IntakeAction>;
  sync: RequestIntakeSyncApi["sync"];
  stageSelected: () => Promise<AttachmentSyncResult>;
  mailItem: RequestIntakeScreenProps["mailItem"];
  state: IntakeState;
  user: RequestIntakeScreenProps["user"];
  requestNote: string;
  uploadDraftKey: string | null;
  intakeDraftKey: string | null;
  existingSync: RequestIntakeSyncApi["existingSync"];
  existingSyncStatus: "pending" | "synced" | "failed" | null;
}): SyncOrchestration {
  const generationRef = useRef(0);
  const activeSyncGenerationRef = useRef<number | null>(null);
  const draftClearedRef = useRef(false);
  // Latency instrumentation: the click's perf clock + trace id, stashed so the
  // fresh (pending) path can log the true submit→synced span when the
  // authoritative query reports the row (applyExistingSyncUpdate) — not only the
  // dedup fast path. Cleared whenever the submit resolves (success or failure).
  const syncClickPerfRef = useRef<number | null>(null);
  const syncTraceRef = useRef<string | null>(null);

  const runSync = useCallback(() => {
    const syncGeneration = generationRef.current + 1;
    generationRef.current = syncGeneration;
    activeSyncGenerationRef.current = syncGeneration;
    dispatch({ type: "syncStarted" });
    // Upload-latency trace: stamp the click (epoch for server correlation, perf
    // for the client span) and mint a trace id threaded through syncRequest so the
    // server [fillTotal] log can join this click to the deferred fill's fence.
    const submitClickedAt = Date.now();
    const syncTraceId = globalThis.crypto.randomUUID();
    const clickPerf = performance.now();
    syncClickPerfRef.current = clickPerf;
    syncTraceRef.current = syncTraceId;
    dlog(`[intake] submit click trace=${syncTraceId}`);
    const payload = buildSyncPayload(mailItem, state, user, requestNote);
    const baseWrite = stageSelected()
      .then((staged) => {
        if (staged.failed.length > 0) {
          console.warn(
            `[intake] skipped ${staged.failed.length} attachment(s): ${staged.failed.map((f) => f.name).join(", ")}`,
          );
        }
        // Staging (the only real wait) is done — advance the meter to the Base
        // row write so the SyncScreen tracks the actual milestone, not a clock.
        if (activeSyncGenerationRef.current === syncGeneration) {
          dispatch({ type: "syncPhaseChanged", phase: "writing" });
        }
        // Hand the staged Convex storageIds straight to syncRequest; the row is
        // created with an empty Sales Files cell and the deferred Attachment Fill
        // writes the files server-side (ADR-0027), so submit never blocks on the
        // serial Drive uploads. Staging already finished above — the only wait.
        return sync({
          ...payload,
          attachmentSources: staged.sources,
          syncTraceId,
          submitClickedAt,
        });
      })
      .then((result) => {
        if (activeSyncGenerationRef.current !== syncGeneration || !result.recordId) return;
        // Client-observed leg: click → row created/visible. The attachment-fill
        // tail runs server-side after this; the server [fillTotal] log closes the
        // full click→fully-written span under the same trace id.
        // Dedup fast path: sync() returned a recordId directly (the row already
        // existed). A fresh submit returns `pending` and resolves via
        // applyExistingSyncUpdate instead, which logs its own submit→synced span.
        dtime(`intake submit→synced·dedup (trace ${syncTraceId})`, clickPerf);
        syncClickPerfRef.current = null;
        const recordId = result.recordId;
        const detailUrl = result.detailUrl ?? null;
        // The staged blobs are deleted server-side after a successful Drive mint,
        // so this conversation's cached storageIds are now dead — drop the draft.
        draftClearedRef.current = true;
        clearUploadDraft(uploadDraftKey);
        clearIntakeDraft(intakeDraftKey);
        // The row exists: fill the meter to 100% and hold a short beat so the
        // completion is visible, then hand off to Received. Generation stays
        // active through the hold; if the authoritative query resolves first,
        // applyExistingSyncUpdate advances and this timer no-ops on the guard.
        dispatch({ type: "syncPhaseChanged", phase: "finalizing" });
        return new Promise<void>((resolve) => {
          window.setTimeout(() => {
            if (activeSyncGenerationRef.current === syncGeneration) {
              activeSyncGenerationRef.current = null;
              dispatch({ type: "syncSucceeded", recordId, detailUrl });
            }
            resolve();
          }, SYNC_COMPLETION_HOLD_MS);
        });
      })
      .catch((e: unknown) => {
        if (activeSyncGenerationRef.current !== syncGeneration) return;
        activeSyncGenerationRef.current = null;
        syncClickPerfRef.current = null;
        dispatch({ type: "syncFailed", message: e instanceof Error ? e.message : "Sync failed" });
      });
    return baseWrite;
  }, [
    dispatch,
    sync,
    mailItem,
    state,
    user,
    requestNote,
    stageSelected,
    uploadDraftKey,
    intakeDraftKey,
  ]);

  const applyExistingSyncUpdate = useCallback(() => {
    if (activeSyncGenerationRef.current === null) return;
    if (existingSyncStatus === "synced" && existingSync?.recordId) {
      activeSyncGenerationRef.current = null;
      // Fresh-path latency: click → row visible — the SyncScreen's true duration.
      // syncRequest returns `pending` on a fresh submit, so this is where the
      // client first sees the row (the dedup path logs its own span above).
      if (syncClickPerfRef.current !== null) {
        dtime(`intake submit→synced (trace ${syncTraceRef.current ?? "—"})`, syncClickPerfRef.current);
        syncClickPerfRef.current = null;
      }
      dispatch({
        type: "syncSucceeded",
        recordId: existingSync.recordId,
        detailUrl: existingSync.detailUrl ?? null,
      });
      return;
    }
    if (existingSyncStatus === "failed") {
      activeSyncGenerationRef.current = null;
      dispatch({
        type: "syncFailed",
        message: existingSync?.error ?? "Could not sync to Feishu Base.",
      });
    }
  }, [
    dispatch,
    existingSync?.detailUrl,
    existingSync?.error,
    existingSync?.recordId,
    existingSyncStatus,
  ]);

  useEffect(() => {
    applyExistingSyncUpdate();
  }, [applyExistingSyncUpdate]);

  return { runSync, applyExistingSyncUpdate, draftClearedRef };
}
