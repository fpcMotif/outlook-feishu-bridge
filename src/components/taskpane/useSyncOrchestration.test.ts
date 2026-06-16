// End-to-end phase integration for the Base Sync pipeline: drives runSync with
// faked stage/sync ports and asserts the real syncPhase milestones reach the
// reducer in order (staging → writing → finalizing → succeeded), plus the error
// and fresh-authoritative-resolution paths. The phase sequence is what the
// SyncScreen meter renders, so this is the contract that keeps it honest.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { IntakeAction, IntakeState } from "./intakeTypes";
import { useSyncOrchestration } from "./useSyncOrchestration";
import type { AttachmentSyncResult } from "./useAttachmentSync";
import type { RequestIntakeSyncApi } from "./requestIntakeSyncApi";

vi.mock("./buildSyncPayload", () => ({
  // The orchestration test cares about the phase pipeline, not payload shape.
  buildSyncPayload: () => ({
    clientEmail: "buyer@example.test",
    subject: "Inquiry",
    from: "buyer@example.test",
    requestNote: "note",
  }),
}));

type SyncFn = RequestIntakeSyncApi["sync"];

const STAGED: AttachmentSyncResult = { sources: [], failed: [] };

function makeProps(overrides: {
  dispatch: (action: IntakeAction) => void;
  sync?: SyncFn;
  stageSelected?: () => Promise<AttachmentSyncResult>;
  existingSync?: RequestIntakeSyncApi["existingSync"];
  existingSyncStatus?: "pending" | "synced" | "failed" | null;
}) {
  return {
    dispatch: overrides.dispatch,
    sync:
      overrides.sync ??
      (vi.fn(() =>
        Promise.resolve({ status: "synced", recordId: "rec1", detailUrl: "url1" }),
      ) as unknown as SyncFn),
    stageSelected:
      overrides.stageSelected ?? (() => Promise.resolve(STAGED)),
    mailItem: {} as never,
    state: {} as IntakeState,
    user: { openId: "ou_rep" },
    requestNote: "note",
    uploadDraftKey: "upload-key",
    intakeDraftKey: "intake-key",
    existingSync: overrides.existingSync ?? null,
    existingSyncStatus: overrides.existingSyncStatus ?? null,
  };
}

const actions = (dispatch: ReturnType<typeof vi.fn>): IntakeAction[] =>
  dispatch.mock.calls.map((call) => call[0] as IntakeAction);

describe("useSyncOrchestration phase pipeline", () => {
  it("advances staging → writing → finalizing → succeeded on the dedup fast path", async () => {
    const dispatch = vi.fn();
    const sync = vi.fn(() =>
      Promise.resolve({ status: "synced", recordId: "rec1", detailUrl: "url1" }),
    ) as unknown as SyncFn;
    const { result } = renderHook((p) => useSyncOrchestration(p), {
      initialProps: makeProps({ dispatch, sync }),
    });

    // runSync resolves only after the finalize hold elapses, so awaiting it means
    // the whole pipeline has run.
    await act(async () => {
      await result.current.runSync();
    });

    expect(actions(dispatch)).toEqual([
      { type: "syncStarted" },
      { type: "syncPhaseChanged", phase: "writing" },
      { type: "syncPhaseChanged", phase: "finalizing" },
      { type: "syncSucceeded", recordId: "rec1", detailUrl: "url1" },
    ]);
    expect(result.current.draftClearedRef.current).toBe(true);
  });

  it("stops at writing and reports failure when the row write rejects", async () => {
    const dispatch = vi.fn();
    const sync = vi.fn(() =>
      Promise.reject(new Error("Base unreachable")),
    ) as unknown as SyncFn;
    const { result } = renderHook((p) => useSyncOrchestration(p), {
      initialProps: makeProps({ dispatch, sync }),
    });

    await act(async () => {
      await result.current.runSync();
    });

    expect(actions(dispatch)).toEqual([
      { type: "syncStarted" },
      { type: "syncPhaseChanged", phase: "writing" },
      { type: "syncFailed", message: "Base unreachable" },
    ]);
    expect(result.current.draftClearedRef.current).toBe(false);
  });

  it("waits for the authoritative query on a fresh (pending) submit, then succeeds", async () => {
    const dispatch = vi.fn();
    // Fresh submit: syncRequest reports pending with no recordId, so the pipeline
    // hands off to the live query instead of finalizing locally.
    const sync = vi.fn(() =>
      Promise.resolve({ status: "pending", recordId: null, detailUrl: null }),
    ) as unknown as SyncFn;
    const { result, rerender } = renderHook((p) => useSyncOrchestration(p), {
      initialProps: makeProps({ dispatch, sync, existingSyncStatus: null }),
    });

    await act(async () => {
      await result.current.runSync();
    });

    // Pending: advanced the meter to writing but did not claim success.
    expect(actions(dispatch)).toEqual([
      { type: "syncStarted" },
      { type: "syncPhaseChanged", phase: "writing" },
    ]);

    // The authoritative query resolves to synced — the internal effect reconciles.
    act(() => {
      rerender(
        makeProps({
          dispatch,
          sync,
          existingSyncStatus: "synced",
          existingSync: {
            status: "synced",
            recordId: "rec-live",
            detailUrl: "url-live",
          } as RequestIntakeSyncApi["existingSync"],
        }),
      );
    });

    expect(actions(dispatch)).toContainEqual({
      type: "syncSucceeded",
      recordId: "rec-live",
      detailUrl: "url-live",
    });
  });
});
