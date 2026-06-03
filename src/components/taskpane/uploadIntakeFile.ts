// Eager Convex storage upload for a picked intake file (ADR-0022). Keeps React
// out of the orchestration so progress + reducer transitions stay unit-testable.

import {
  mimeFromName,
  postBytesToConvexWithProgress,
  type AttachmentStagingDeps,
} from "../../office/attachmentUpload";
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
): void {
  for (const upload of uploads) {
    if (upload.rejection !== null) continue;
    if (inFlight.has(upload.id) || completedStorage.has(upload.id)) continue;
    void uploadIntakeFileToStorage(deps, upload, dispatch);
  }
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
