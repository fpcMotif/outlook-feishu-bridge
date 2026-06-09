// Eager Convex storage upload for a picked intake file (ADR-0022). Keeps React
// out of the orchestration so progress + reducer transitions stay unit-testable.

import { fileExtension } from "../../office/attachments";
import {
  mimeFromName,
  postBytesToConvexWithProgress,
  readFileBytesWithRetry,
  uploadBlobWithRetry,
  type AttachmentStagingDeps,
} from "../../office/attachmentUpload";
import { reportUploadError } from "../../sentry";
import { runWithConcurrency, UPLOAD_CONCURRENCY } from "./runWithConcurrency";
import type { IntakeAction, UploadedFile } from "./intakeReducer";

const inFlight = new Map<string, Promise<void>>();
const completedStorage = new Map<string, string>();

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
}

export function intakeUploadInFlight(id: string): Promise<void> | undefined {
  return inFlight.get(id);
}

export async function awaitIntakeUploads(ids: string[]): Promise<void> {
  // Best-effort: a tracked upload promise REJECTS when its upload fails (the
  // inner .catch re-throws). Swallow each rejection here so one late failure at
  // submit time can't reject Promise.all and abort the whole sync — the reducer
  // already recorded the error row and gatherAttachmentSources skips the failed
  // pick, so the sync proceeds with the rest (the documented best-effort path).
  await Promise.all(
    ids.map((id) => (inFlight.get(id) ?? Promise.resolve()).catch(() => {})),
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
  // Read the bytes ONCE, up front, with retry — the first read of a cloud
  // placeholder (Dropbox / OneDrive "Files On-Demand") triggers Windows to hydrate
  // the file, so a short retry usually succeeds with no user action. A handle that
  // stays unreadable throws a tagged error the row surfaces with a Re-add button.
  const bytes = await readFileBytesWithRetry(upload.file);
  const blob = new Blob([bytes], {
    type: upload.file.type || mimeFromName(upload.file.name),
  });
  // Re-mints a fresh upload URL per attempt and retries transport errors with
  // backoff (Convex URLs are single-use); a single cross-border reset no longer
  // dead-ends the upload. Server (4xx/5xx) and read failures are NOT retried.
  const { storageId } = await uploadBlobWithRetry(
    deps.generateUploadUrl,
    blob,
    (progress) => {
      dispatch({ type: "uploadProgressUpdated", id: upload.id, progress });
    },
    postBytesToConvexWithProgress,
  );
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
      // Report the TERMINAL failure (uploadBlobWithRetry already exhausted its
      // in-flight transport retries) as a handled Sentry event with size/type/kind
      // — no longer an unhandled rejection, and now chartable. attempts is the
      // transport-retry budget; read/server failures terminate on the first try.
      reportUploadError(e, {
        bytes: upload.file.size,
        ext: fileExtension(upload.file.name),
        attempts: 3,
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
): void {
  const pending = uploads.filter(
    (upload) =>
      upload.rejection === null &&
      !inFlight.has(upload.id) &&
      !completedStorage.has(upload.id),
  );
  if (pending.length === 0) return;
  // Cap concurrency so a big batch (e.g. 15 screenshots) does not saturate the
  // WebView's per-origin connection pool and self-inflict "network" failures.
  // runWithConcurrency owns each item's errors; the inner .catch in
  // uploadIntakeFileToStorage still drives the reducer's error row + retry, so a
  // failed upload is surfaced without escaping to window.onunhandledrejection.
  void runWithConcurrency(pending, UPLOAD_CONCURRENCY, (upload) =>
    uploadIntakeFileToStorage(deps, upload, dispatch),
  );
}

export function retryIntakeFileUpload(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  upload: { id: string; file: File },
  dispatch: (action: IntakeAction) => void,
): void {
  clearIntakeUploadCache(upload.id);
  dispatch({ type: "uploadRetryRequested", id: upload.id });
  // Same fire-and-forget contract as queueIntakeFileUploads: the inner .catch
  // already drives the row's error state, so swallow here to avoid an unhandled
  // rejection on a retry that also fails.
  void uploadIntakeFileToStorage(deps, upload, dispatch).catch(() => {});
}

// Retry a whole batch of failed uploads at once (the "Retry all" affordance).
// Resets each row to pending, then drives them through the SAME concurrency cap
// as the initial queue — so retrying 15 files does NOT re-create the burst that
// caused the failures in the first place.
export function retryIntakeFileUploads(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  uploads: { id: string; file: File; rejection: string | null }[],
  dispatch: (action: IntakeAction) => void,
): void {
  const retryable = uploads.filter((upload) => upload.rejection === null);
  if (retryable.length === 0) return;
  for (const upload of retryable) {
    clearIntakeUploadCache(upload.id);
    dispatch({ type: "uploadRetryRequested", id: upload.id });
  }
  queueIntakeFileUploads(deps, retryable, dispatch);
}

// Re-add affordance for an UNREADABLE pick (Dropbox/OneDrive placeholder): the
// user re-selects the file, which hands us a FRESH File handle (hydrated by now,
// or with a current mtime), so unlike Retry — which re-reads the same dead handle
// — this can actually succeed. Swaps the row's file in place (preserving its id +
// selection) and re-queues. The caller (useIntakeAttachments) has already
// validated the pick and dispatched `uploadFileReplaced`.
export function replaceIntakeFileUpload(
  deps: Pick<AttachmentStagingDeps, "generateUploadUrl">,
  upload: { id: string; file: File },
  dispatch: (action: IntakeAction) => void,
): void {
  clearIntakeUploadCache(upload.id);
  void uploadIntakeFileToStorage(deps, upload, dispatch).catch(() => {});
}
