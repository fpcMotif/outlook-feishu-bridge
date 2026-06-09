// Eager Convex storage upload for a picked intake file (ADR-0022). Keeps React
// out of the orchestration so progress + reducer transitions stay unit-testable.

import {
  mimeFromName,
  postBytesToConvexWithProgress,
  type AttachmentStagingDeps,
} from "../../office/attachmentUpload";
import type { IntakeAction, UploadedFile } from "./intakeReducer";

// Cap on simultaneous Convex storage POSTs from queueIntakeFileUploads. Office-
// on-the-web shares one webview connection pool, so fanning out a whole burst of
// picked files at once saturates it: every `POST .../api/storage/upload` fails
// with net::ERR_FAILED, the Convex WebSocket drops (1006), and even Outlook's
// own notification channel gets starved (observed 2026-06-09 with ~30 images).
// A small worker pool drains bursts without exhausting the socket budget.
export const INTAKE_UPLOAD_CONCURRENCY = 4;

const inFlight = new Map<string, Promise<void>>();
const completedStorage = new Map<string, string>();
// Ids reserved by the worker pool but not yet started (so not in `inFlight`
// yet). Tracked so a re-entrant queue call can't double-enqueue them — this
// extends the in-flight dedupe across the pool's pending window.
const queued = new Set<string>();

export function mergeStagedUploads(uploads: UploadedFile[]): UploadedFile[] {
  return uploads.map((upload) => {
    const storageId = completedStorage.get(upload.id);
    if (!storageId) return upload;
    return {
      ...upload,
      storageId,
      status: "complete" as const,
      progress: 100,
      uploadError: null,
    };
  });
}

export function clearIntakeUploadCache(id: string): void {
  completedStorage.delete(id);
  inFlight.delete(id);
  queued.delete(id);
}

/**
 * Drop ALL module-level upload bookkeeping. These Maps live outside React, so a
 * key-remount of the intake tree does not clear them; call this when the intake
 * context (conversation) switches on a long-lived pinned pane so stale storage
 * ids cannot ride into the next conversation and completedStorage cannot grow
 * unbounded across a marathon session. Idempotent (safe under StrictMode).
 */
export function resetIntakeUploadCaches(): void {
  inFlight.clear();
  completedStorage.clear();
  queued.clear();
}

export function intakeUploadInFlight(id: string): Promise<void> | undefined {
  return inFlight.get(id);
}

export async function awaitIntakeUploads(ids: string[]): Promise<void> {
  await Promise.all(
    ids.map((id) => inFlight.get(id) ?? Promise.resolve()),
  );
}

async function performIntakeUpload(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  upload: { id: string; file: File },
  dispatch: (action: IntakeAction) => void,
): Promise<void> {
  dispatch({
    type: "uploadStatusChanged",
    id: upload.id,
    status: "uploading",
    uploadError: null,
  });
  const url = await deps.generateUploadUrl();
  const blob = new Blob([upload.file], {
    type: upload.file.type || mimeFromName(upload.file.name),
  });
  const { storageId } = await postBytesToConvexWithProgress(url, blob, (progress) => {
    dispatch({ type: "uploadProgressUpdated", id: upload.id, progress });
  });
  completedStorage.set(upload.id, storageId);
  dispatch({
    type: "uploadStatusChanged",
    id: upload.id,
    status: "complete",
    progress: 100,
    storageId,
    uploadError: null,
  });
}

export function uploadIntakeFileToStorage(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  upload: { id: string; file: File },
  dispatch: (action: IntakeAction) => void,
): Promise<void> {
  const existing = inFlight.get(upload.id);
  if (existing) return existing;

  const tracked = performIntakeUpload(deps, upload, dispatch)
    .catch((e: unknown) => {
      const message = e instanceof Error ? e.message : String(e);
      dispatch({
        type: "uploadStatusChanged",
        id: upload.id,
        status: "error",
        uploadError: message,
      });
      throw e;
    })
    .finally(() => {
      inFlight.delete(upload.id);
    });

  inFlight.set(upload.id, tracked);
  return tracked;
}

export function queueIntakeFileUploads(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  uploads: { id: string; file: File; rejection: string | null }[],
  dispatch: (action: IntakeAction) => void,
  concurrency: number = INTAKE_UPLOAD_CONCURRENCY,
): void {
  // Reserve eligible ids synchronously (before any await) so a re-entrant queue
  // call can't double-enqueue an id that is still pending in the pool — keeping
  // the in-flight dedupe intact for the window before an upload reaches inFlight.
  const pending: { id: string; file: File }[] = [];
  for (const upload of uploads) {
    if (upload.rejection !== null) continue;
    if (
      inFlight.has(upload.id) ||
      completedStorage.has(upload.id) ||
      queued.has(upload.id)
    ) {
      continue;
    }
    queued.add(upload.id);
    pending.push({ id: upload.id, file: upload.file });
  }
  if (pending.length === 0) return;

  // Drain `pending` through a fixed pool of `concurrency` workers so a burst of
  // picked files never floods the shared webview connection pool all at once.
  let next = 0;
  const runWorker = async (): Promise<void> => {
    while (next < pending.length) {
      const upload = pending[next];
      next += 1;
      queued.delete(upload.id);
      try {
        await uploadIntakeFileToStorage(deps, upload, dispatch);
      } catch {
        // Per-file failure is already surfaced as an error row and stays
        // retryable via retryIntakeFileUpload; keep the pool draining.
      }
    }
  };

  const workerCount = Math.min(Math.max(1, concurrency), pending.length);
  for (let i = 0; i < workerCount; i += 1) void runWorker();
}

export function retryIntakeFileUpload(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  upload: { id: string; file: File },
  dispatch: (action: IntakeAction) => void,
): void {
  clearIntakeUploadCache(upload.id);
  dispatch({ type: "uploadRetryRequested", id: upload.id });
  void uploadIntakeFileToStorage(deps, upload, dispatch);
}
