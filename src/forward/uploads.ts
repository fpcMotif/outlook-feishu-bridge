// Binary upload helpers split out of forwardEmail (ADR-0004): how attachments,
// inline images, and large PDFs cross SPA -> Convex File Storage -> Feishu. Kept
// out of the orchestrator so forwardEmail stays focused on sequencing.

import type { AttachmentInfo } from "../office/useMailItem";
import type { ForwardDeps, StorageId, DocMedia, AttachmentKey } from "./forwardEmail";
import { dtime } from "../debug";

function base64ToBlob(base64: string, contentType: string): Blob {
  const binaryStr = atob(base64);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.codePointAt(i)!;
  }
  return new Blob([bytes], { type: contentType });
}

// Stage a blob in Convex File Storage and return its id. This is THE way
// binaries cross SPA -> Convex: over the upload URL (no size cap), never as a
// Convex function argument (Node-action args cap at 5 MiB). See ADR-0004.
export async function putBlobInStorage(
  deps: ForwardDeps,
  blob: Blob,
  contentType: string,
  label: string,
): Promise<StorageId> {
  const tStage = performance.now();
  const uploadUrl = await deps.generateUploadUrl();
  const resp = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: blob,
  });
  const { storageId } = await resp.json();
  dtime(`stage ${label}`, tStage);
  return storageId;
}

async function uploadToStorage(deps: ForwardDeps, att: AttachmentInfo): Promise<StorageId> {
  const tRead = performance.now();
  const content = await deps.getAttachmentContent(att.id);
  const blob = base64ToBlob(content.content, att.contentType);
  dtime(`read+decode "${att.name}" (${att.size}B)`, tRead);
  return putBlobInStorage(deps, blob, att.contentType, `"${att.name}"`);
}

export async function uploadOneAttachment(deps: ForwardDeps, att: AttachmentInfo): Promise<AttachmentKey> {
  const storageId = await uploadToStorage(deps, att);
  const tUp = performance.now();
  if (att.contentType.startsWith("image/")) {
    const result = await deps.uploadImage({ storageId, fileName: att.name, contentType: att.contentType });
    dtime(`feishu image upload "${att.name}"`, tUp);
    return { fileKey: result.imageKey, fileName: att.name, type: "image" };
  }
  const result = await deps.uploadAttachment({ storageId, fileName: att.name, contentType: att.contentType });
  dtime(`feishu file upload "${att.name}"`, tUp);
  return { fileKey: result.fileKey, fileName: att.name, type: "file" };
}

export async function uploadDocAttachments(
  deps: ForwardDeps,
  attachments: AttachmentInfo[],
  label: string,
): Promise<DocMedia[]> {
  deps.onProgress(`Uploading ${attachments.length} doc ${label}(s)...`);
  // Concurrent + best-effort: one bad attachment shouldn't abort the whole doc.
  const results = await Promise.all(
    attachments.map(async (att): Promise<DocMedia | null> => {
      try {
        const storageId = await uploadToStorage(deps, att);
        return { storageId, fileName: att.name };
      } catch {
        return null;
      }
    }),
  );
  return results.filter((r): r is DocMedia => r !== null);
}
