/* eslint-disable max-lines -- one cohesive upload module: mime/base64, staging,
   fetch + XHR byte POSTs, transport-retry, and the cloud-aware file read. */
// SPA attachment pipeline (ADR-0022 / ADR-0027): turn picker selections —
// existing mail attachments downloaded as Base64 plus user-uploaded DOM Files —
// into STAGED Convex File-Storage refs for the Base row. The SPA only stages
// bytes here (the one wait, and it's the fast/local leg). The Feishu Drive
// upload_all that mints `file_token`s now runs server-side in the deferred
// Attachment Fill (off the submit critical path — ADR-0027), so submit never
// blocks on the serial 5 QPS Drive uploads. The SPA never touches Feishu Drive
// directly (no Drive-scoped token / CORS path, 20 MB > Convex action-arg cap).

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
// longer a submit-path dependency — upload_all moved into the deferred
// Attachment Fill worker, ADR-0027.)
export interface AttachmentStagingDeps {
  generateUploadUrl: () => Promise<string>;
  uploadBytes: (url: string, blob: Blob) => Promise<{ storageId: string }>;
}

// A staged file ready for the backend Attachment Fill to upload to Drive: the
// Convex storage id plus the display name — exactly the `attachmentSources`
// shape syncRequest takes.
export interface StagedAttachmentSource {
  storageId: string;
  fileName: string;
}

// Stage each blob to Convex File Storage and return the staged { storageId,
// fileName } refs in input order. Sources that arrived already staged (eager
// intake uploads carry a storageId) skip the byte POST. The Drive upload_all NO
// LONGER happens here — it runs server-side in the deferred Attachment Fill
// (ADR-0027), so submit stays off the serial 5 QPS Drive critical path. Empty
// input short-circuits with no network calls. This local staging is the only
// thing the salesperson waits for (the hard deadline before the pane can close —
// Office.js bytes are unrecoverable after close).
export async function stageAttachmentSources(
  deps: AttachmentStagingDeps,
  sources: AttachmentSource[],
  retryOptions?: UploadRetryOptions,
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
      // Same resilience as the eager path: re-mint a fresh URL per attempt and
      // retry transport errors. The injected uploadBytes (postBytesToConvex) tags
      // network/timeout failures as retryable; the adapter keeps the DI seam.
      const { storageId } = await uploadBlobWithRetry(
        deps.generateUploadUrl,
        source.blob,
        undefined,
        (url, blob) => deps.uploadBytes(url, blob),
        retryOptions,
      );
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
  timeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS,
): Promise<{ storageId: string }> {
  // fetch() has no timeout — an AbortController bounds a stalled cross-border POST
  // so it fails fast enough to retry instead of hanging.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": blob.type || "application/octet-stream" },
      body: blob,
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`Convex storage upload failed (${res.status})`);
    return (await res.json()) as { storageId: string };
  } catch (err) {
    // fetch rejects with a TypeError on transport failure and an AbortError on
    // timeout — tag both retryable so uploadBlobWithRetry absorbs them. A server
    // status (thrown above) or bad JSON stays untagged (a retry won't fix it).
    if (err instanceof DOMException && err.name === "AbortError") {
      throw transportError("Convex storage upload timed out");
    }
    if (err instanceof TypeError) {
      throw transportError("Convex storage upload failed (network)");
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export type UploadProgressListener = (loadedRatio: number) => void;

// Transport-level failures — the XHR `error`/`timeout` events: a TCP reset, a
// TLS/DNS hiccup, a stalled cross-border link, or a blob whose backing file
// could not be read (a dehydrated Dropbox/OneDrive placeholder) — are tagged so
// the retry layer (uploadBlobWithRetry) can tell them apart from a genuine server
// reply (a 4xx/5xx `load`) or malformed JSON, neither of which a retry would fix.
// The user-facing message string is unchanged, so Sentry grouping is preserved.
const RETRYABLE_UPLOAD_ERROR = "ConvexUploadTransportError";

function transportError(message: string): Error {
  const err = new Error(message);
  err.name = RETRYABLE_UPLOAD_ERROR;
  return err;
}

export function isRetryableUploadError(err: unknown): boolean {
  return err instanceof Error && err.name === RETRYABLE_UPLOAD_ERROR;
}

// Per-attempt ceiling so a stalled cross-border connection fails fast enough to
// be retried instead of hanging until the WebView/OS aborts it (XHR has no
// default timeout). 60s comfortably covers a large attachment on a slow link.
const DEFAULT_UPLOAD_TIMEOUT_MS = 60_000;

// XMLHttpRequest exposes upload progress; fetch does not. Used for eager intake
// uploads so large files show real byte progress in the attachment row.
export function postBytesToConvexWithProgress(
  url: string,
  blob: Blob,
  onProgress?: UploadProgressListener,
  timeoutMs: number = DEFAULT_UPLOAD_TIMEOUT_MS,
): Promise<{ storageId: string }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.timeout = timeoutMs;
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
      reject(transportError("Convex storage upload failed (network)")),
    );
    xhr.addEventListener("timeout", () =>
      reject(transportError("Convex storage upload timed out")),
    );
    xhr.send(blob);
  });
}

export interface UploadRetryOptions {
  attempts?: number;
  timeoutMs?: number;
  backoffMs?: number;
  delay?: (ms: number) => Promise<void>;
  // Injectable [0,1) source for the backoff jitter — defaults to Math.random.
  // Tests pass () => 0 to pin the delay to the exact base for assertions.
  random?: () => number;
}

// Bounded retry-with-backoff around the byte POST. Each attempt re-mints a FRESH
// upload URL because Convex storage URLs are single-use and TTL-bound — reusing
// one across attempts would 4xx. Only transport errors are retried; a server
// `load` (4xx/5xx) or bad JSON throws on the first try (retrying won't help). The
// byte-poster and the backoff delay are injected so this stays unit-testable
// without a real XHR or real timers. This is what absorbs the single-reset-on-a-
// flaky-link failure that used to surface to the user as an unrecoverable upload.
export async function uploadBlobWithRetry(
  generateUploadUrl: () => Promise<string>,
  blob: Blob,
  onProgress: UploadProgressListener | undefined,
  postBytes: (
    url: string,
    blob: Blob,
    onProgress?: UploadProgressListener,
    timeoutMs?: number,
  ) => Promise<{ storageId: string }>,
  options?: UploadRetryOptions,
): Promise<{ storageId: string }> {
  const attempts = options?.attempts ?? 3;
  const timeoutMs = options?.timeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  const backoffMs = options?.backoffMs ?? 800;
  const random = options?.random ?? Math.random;
  const delay =
    options?.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const url = await generateUploadUrl();
      return await postBytes(url, blob, onProgress, timeoutMs);
    } catch (err) {
      lastError = err;
      if (!isRetryableUploadError(err) || attempt === attempts) throw err;
      // Full jitter on top of the exponential base: when a whole batch retries at
      // once, an un-jittered schedule makes every file's wave land on the same
      // wall-clock and re-saturate the connection pool. Spreading each delay over
      // [base, 2·base) de-syncs them. random() defaults to Math.random.
      const base = backoffMs * 2 ** (attempt - 1);
      await delay(base + Math.floor(random() * base));
    }
  }
  // Unreachable: the final attempt always returns or throws above.
  throw lastError instanceof Error
    ? lastError
    : new Error("Convex storage upload failed");
}

// --- Reading picked-file bytes (cloud-aware) ---------------------------------

const FILE_UNREADABLE_ERROR = "ConvexFileUnreadableError";

// Shown on the attachment row when the browser cannot read a picked file's bytes —
// almost always a dehydrated cloud placeholder (Dropbox / OneDrive "Files
// On-Demand"; Windows routinely redirects Desktop/Documents/Pictures into OneDrive,
// so even a "local" pick can be online-only). The Re-add button keys off this exact
// message, so keep them in sync.
export const UNREADABLE_FILE_MESSAGE =
  "Couldn't read this file — it may still be downloading from Dropbox/OneDrive. " +
  "Wait a moment, then use Re-add to pick it again.";

export function isUnreadableFileError(err: unknown): boolean {
  return err instanceof Error && err.name === FILE_UNREADABLE_ERROR;
}

export interface FileReadOptions {
  attempts?: number;
  backoffMs?: number;
  delay?: (ms: number) => Promise<void>;
}

// Read a picked file's bytes ONCE, up front, with retry. The FIRST read of a cloud
// placeholder triggers Windows to hydrate (download) the file, but can throw
// NotReadableError before the bytes land; retrying a few times gives the download
// time to finish, so most cloud-backed picks upload with NO user action. After the
// budget is spent we throw a tagged, user-actionable error — the genuine re-add
// case (a handle invalidated by a re-sync keeps failing no matter how often the
// same File object is re-read). Delay is injected so tests run without real timers.
export async function readFileBytesWithRetry(
  file: Pick<Blob, "arrayBuffer">,
  options?: FileReadOptions,
): Promise<ArrayBuffer> {
  const attempts = options?.attempts ?? 4;
  const backoffMs = options?.backoffMs ?? 600;
  const delay =
    options?.delay ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await file.arrayBuffer();
    } catch {
      if (attempt === attempts) break;
      await delay(backoffMs * 2 ** (attempt - 1));
    }
  }
  const unreadable = new Error(UNREADABLE_FILE_MESSAGE);
  unreadable.name = FILE_UNREADABLE_ERROR;
  throw unreadable;
}
