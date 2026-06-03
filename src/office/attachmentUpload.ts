// SPA attachment pipeline (ADR-0022): turn picker selections — existing mail
// attachments downloaded as Base64 plus user-uploaded DOM Files — into Feishu
// Drive file_tokens for the Base row. Bytes are staged through Convex File
// Storage, then minted into tokens by the uploadAttachmentsToDrive action; the
// SPA never touches Feishu Drive directly (no Drive-scoped token / CORS path,
// and a 20 MB file would exceed the Convex action-arg cap — see ADR-0022).

import { fileExtension } from "./attachments";

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
// upload-URL mint, the raw byte POST, and the Drive token-minting action.
export interface AttachmentStagingDeps {
  generateUploadUrl: () => Promise<string>;
  uploadBytes: (url: string, blob: Blob) => Promise<{ storageId: string }>;
  uploadToDrive: (
    sources: { storageId: string; fileName: string }[],
  ) => Promise<{ attachments: { fileToken: string }[] }>;
}

// Stage each blob to Convex File Storage, then mint Feishu Drive file_tokens in
// one backend call. Returns the [{ fileToken }] shape syncRequest consumes, in
// input order. Empty input short-circuits with no network calls.
export async function stageAndUploadAttachments(
  deps: AttachmentStagingDeps,
  sources: AttachmentSource[],
): Promise<{ fileToken: string }[]> {
  if (sources.length === 0) return [];
  const staged = await Promise.all(
    sources.map(async (source) => {
      if (source.storageId) {
        return { storageId: source.storageId, fileName: source.name };
      }
      if (!source.blob) {
        throw new Error(`Attachment source "${source.name}" has no blob or storageId`);
      }
      const url = await deps.generateUploadUrl();
      const { storageId } = await deps.uploadBytes(url, source.blob);
      return { storageId, fileName: source.name };
    }),
  );
  const { attachments } = await deps.uploadToDrive(staged);
  return attachments;
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
