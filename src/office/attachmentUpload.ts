// SPA attachment pipeline (ADR-0022): turn picker selections — existing mail
// attachments downloaded as Base64 plus user-uploaded DOM Files — into STAGED
// Convex File-Storage refs for the Base row. The SPA only stages bytes here; the
// Feishu Drive upload_all that mints `file_token`s now runs server-side in the
// deferred Base-write worker (off the submit critical path — ADR-0022 latency
// optimization), so the submit no longer blocks on the serial 5 QPS Drive
// uploads. The SPA never touches Feishu Drive directly (no Drive-scoped token /
// CORS path, and a 20 MB file would exceed the Convex action-arg cap).

import { fileExtension } from "./attachments";
import { dtime } from "../debug";

// Office.js getAttachmentContentAsync exposes no usable contentType (deprecated),
// so MIME is derived from the file extension (ADR-0022). pdf / excel / word /
// image are the accepted upload kinds; anything else stages as octet-stream.
const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: "application/pdf",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
};

export function mimeFromName(name: string): string {
  return MIME_BY_EXTENSION[fileExtension(name)] ?? "application/octet-stream";
}

// Decode an Office.js Base64 attachment payload into a typed Blob for staging.
export function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (ch) => ch.codePointAt(0) ?? 0);
  return new Blob([bytes], { type: mimeType });
}

// One file ready to stage: display name plus bytes and/or an existing storage id
// from an eager intake upload (skips the Convex byte POST at sync time).
export interface AttachmentSource {
  name: string;
  blob?: Blob;
  storageId?: string;
}

// Injected so the orchestration stays pure and testable: the Convex storage
// upload-URL mint and the raw byte POST. (The Drive token-minting action is no
// longer a submit-path dependency — it moved into the backend sync worker.)
export interface AttachmentStagingDeps {
  generateUploadUrl: () => Promise<string>;
  uploadBytes: (url: string, blob: Blob) => Promise<{ storageId: string }>;
}

// A staged file ready for the backend to upload to Drive: the Convex storage id
// plus the display name. Exactly the `attachmentSources` shape syncRequest takes.
export interface StagedAttachmentSource {
  storageId: string;
  fileName: string;
}

// Stage each blob to Convex File Storage and return the staged { storageId,
// fileName } refs in input order — the `attachmentSources` shape syncRequest
// consumes. Sources that arrived already staged (eager intake uploads carry a
// storageId) skip the byte POST. The Drive upload_all NO LONGER happens here: it
// runs server-side in the deferred Base-write worker, so the submit path stays
// off the serial 5 QPS Drive critical path (ADR-0022). Empty input
// short-circuits with no network calls.
export async function stageAttachmentSources(
  deps: AttachmentStagingDeps,
  sources: AttachmentSource[],
): Promise<StagedAttachmentSource[]> {
  if (sources.length === 0) return [];
  const stageStarted = performance.now();
  const staged = await Promise.all(
    sources.map(async (source) => {
      if (source.storageId) {
        return { storageId: source.storageId, fileName: source.name };
      }
      if (!source.blob) {
        throw new Error(
          `Attachment source "${source.name}" has no blob or storageId`,
        );
      }
      const url = await deps.generateUploadUrl();
      const { storageId } = await deps.uploadBytes(url, source.blob);
      return { storageId, fileName: source.name };
    }),
  );
  dtime(`attachment storage stage (${staged.length} files)`, stageStarted);
  return staged;
}

// Default uploadBytes: POST raw bytes to a Convex storage upload URL (1 h TTL),
// which responds with the new { storageId }. The SPA wires this into the staging
// deps; injected above so the orchestration stays fetch-free in tests.
export async function postBytesToConvex(
  url: string,
  blob: Blob,
): Promise<{ storageId: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": blob.type || "application/octet-stream" },
    body: blob,
  });
  if (!res.ok) throw new Error(`Convex storage upload failed (${res.status})`);
  return (await res.json()) as { storageId: string };
}

export type UploadProgressListener = (loadedRatio: number) => void;

// XMLHttpRequest exposes upload progress; fetch does not. Used for eager intake
// uploads so large files show real byte progress in the attachment row.
export function postBytesToConvexWithProgress(
  url: string,
  blob: Blob,
  onProgress?: UploadProgressListener,
): Promise<{ storageId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader(
      "Content-Type",
      blob.type || "application/octet-stream",
    );
    xhr.upload.addEventListener("progress", (event) => {
      if (!onProgress || !event.lengthComputable || event.total <= 0) return;
      onProgress(Math.min(100, Math.round((event.loaded / event.total) * 100)));
    });
    xhr.addEventListener("load", () => {
      if (xhr.status < 200 || xhr.status >= 300) {
        reject(new Error(`Convex storage upload failed (${xhr.status})`));
        return;
      }
      try {
        resolve(JSON.parse(xhr.responseText) as { storageId: string });
      } catch {
        reject(new Error("Convex storage upload returned invalid JSON"));
      }
    });
    xhr.addEventListener("error", () =>
      reject(new Error("Convex storage upload failed (network)")),
    );
    xhr.send(blob);
  });
}
