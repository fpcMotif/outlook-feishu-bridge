// Feishu Drive media upload for ADR-0022: stage email-attachment bytes through
// Convex File Storage, then push each blob to Drive `medias/upload_all` so its
// `file_token` can be written into the Base row's Attachment cell (type 17).
// The token is minted BEFORE the idempotent Bitable create, so a client_token
// retry re-sends the same token and never re-uploads bytes (see requestSync.ts).
//
// Contract is cited to the official Feishu doc (the only source of truth):
//   POST /open-apis/drive/v1/medias/upload_all
//   https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all
// FEISHU_BASE already prepends /open-apis, so the path here omits it. Auth is
// "tenant"; scope bitable:app already covers parent_type=bitable_file (ADR-0011).

import { action, type ActionCtx } from "../_generated/server";
import { v } from "convex/values";
import { callFeishu, resolveFeishuToken } from "./call";
import { FeishuError } from "./client";
import { getStorageBytes } from "../storage";
import type { Id } from "../_generated/dataModel";

// ADR-0022 decision #4: single-shot only. Reject any file larger than 20 MiB
// before uploading — the chunked upload_prepare path is not implemented in v1.
export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

// Feishu frequency control. The official medias/upload_all doc says this endpoint
// does not support concurrent calls and caps it at 5 QPS / 10 000-per-day per app:
//   https://open.feishu.cn/document/server-docs/docs/drive-v1/media/upload_all
// Exceeding it returns HTTP 429 with the GATEWAY code 99991400 "request trigger
// frequency limit" (this code is NOT in the endpoint's own 1061xxx/1062xxx list).
// Observed live as `code 99991400 ... at async Promise.all (index 5)` — 6 parallel
// uploads > 5 QPS:
//   https://open.feishu.cn/document/server-docs/api-call-guide/generic-error-code
// Feishu's documented remedy is exponential backoff — quote: "建议使用指数退避算法",
// so we upload SERIALLY (one request in flight) and retry 99991400 with exp backoff.
// (Strictly-correct: honor the `x-ogw-ratelimit-reset` 429 response header — a
// future enhancement; FeishuError does not yet surface response headers.)
//   https://open.feishu.cn/document/server-docs/api-call-guide/frequency-control
export const FEISHU_RATE_LIMIT_CODE = 99991400;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

// Drive upload concurrency (ADR-0027). `medias/upload_all` is 5 QPS, NOT
// concurrency-of-one, so a small pool cuts the serial ~14s/10-files to ~3s. The
// cap is configurable (never an inline literal) and hard-bounded ≤5 to stay
// under the 5 QPS budget; overlap with another fill self-corrects via the
// 99991400 + reset-header retry. Read at call time (Convex env is live).
export const DEFAULT_DRIVE_UPLOAD_CONCURRENCY = 4;
const MAX_DRIVE_UPLOAD_CONCURRENCY = 5;

export function driveUploadConcurrency(): number {
  const raw = process.env.FEISHU_DRIVE_UPLOAD_CONCURRENCY;
  const parsed = raw ? Number(raw) : NaN;
  const wanted = Number.isFinite(parsed) && parsed >= 1 ? Math.floor(parsed) : DEFAULT_DRIVE_UPLOAD_CONCURRENCY;
  return Math.min(wanted, MAX_DRIVE_UPLOAD_CONCURRENCY);
}

/**
 * Run `fn` over `items` with at most `limit` in flight at once, returning results
 * in input order. Pure orchestration (no Drive/Feishu coupling) so the latency
 * core is unit-tested without real uploads (ADR-0019 seam).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const results = new Array<R>(items.length);
  const width = Math.max(1, Math.min(limit, items.length));
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      // eslint-disable-next-line react-doctor/async-await-in-loop -- bounded-concurrency pool: each worker drains its share sequentially; parallelism is across the `width` workers (Promise.all below)
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: width }, () => worker()));
  return results;
}

/**
 * Run a Drive upload, retrying ONLY Feishu's 99991400 frequency-limit with
 * exponential backoff (500ms · 1s · 2s …). Any other error — or exhausting
 * `maxAttempts` — rethrows unchanged. `sleep` is injectable so the retry policy
 * is unit-testable without real waits (ADR-0019 extract-then-test seam).
 */
export async function withDriveRateLimitRetry<T>(
  upload: () => Promise<T>,
  opts: {
    maxAttempts?: number;
    backoffMs?: (attempt: number) => number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 4;
  const backoffMs = opts.backoffMs ?? ((attempt) => 500 * 2 ** attempt);
  const doSleep = opts.sleep ?? sleep;
  for (let attempt = 0; ; attempt++) {
    try {
      // eslint-disable-next-line react-doctor/async-await-in-loop -- retry loop is inherently sequential (rate-limit backoff)
      return await upload();
    } catch (e: unknown) {
      const rateLimited =
        e instanceof FeishuError && e.code === FEISHU_RATE_LIMIT_CODE;
      if (!rateLimited || attempt >= maxAttempts - 1) throw e;
      // Honor the server's reset hint when present (ADR-0027); else exp backoff.
      const hinted = e instanceof FeishuError ? e.retryAfterMs : undefined;
      await doSleep(hinted ?? backoffMs(attempt));
    }
  }
}

/**
 * Upload one blob to Feishu Drive via `medias/upload_all` and return its
 * `file_token`. Builds the multipart body per the verified contract (the runtime
 * sets the boundary); throws when the response carries no `file_token`.
 */
export async function uploadMediaToDrive(
  ctx: ActionCtx,
  blob: Blob,
  fileName: string,
  appToken: string,
  tenantToken?: string,
): Promise<string> {
  const form = new FormData();
  form.set("file_name", fileName);
  form.set("parent_type", "bitable_file");
  form.set("parent_node", appToken);
  form.set("size", String(blob.size));
  form.set("file", blob);

  const data = await callFeishu<{ file_token?: string }>(ctx, {
    path: "/drive/v1/medias/upload_all",
    method: "POST",
    auth: "tenant",
    token: tenantToken,
    form,
    label: "Feishu Drive media upload_all",
  });
  if (!data.file_token) {
    throw new Error("Feishu Drive upload_all returned no file_token");
  }
  return data.file_token;
}

interface DriveSource {
  storageId: Id<"_storage">;
  fileName: string;
}

// One staged source for the deferred Attachment Fill (ADR-0027). storageId is an
// opaque string here (stored that way on the Email Record); cast at the storage
// boundary only.
export interface StagedAttachmentSource {
  storageId: string;
  fileName: string;
}

export type StagedSourceOutcome =
  | { kind: "minted"; fileToken: string; storageId: string; fileName: string }
  // Permanent per-file failure (dead/GC'd source, >20 MB): never retried.
  | { kind: "skipped"; fileName: string; storageId: string }
  // Transient (rate-limit storm beyond retry, network): kept for the fill's retry.
  | { kind: "deferred"; fileName: string; storageId: string };

/**
 * Mint ONE staged source's Drive `file_token` without deleting the staged blob
 * (the fill persists the token first, then deletes — Drive upload_all is not
 * idempotent, ADR-0027). Classifies the failure: a dead/GC'd or oversize source
 * is a permanent `skipped`; a Drive transport failure is a `deferred` retry.
 */
export async function mintOneStagedSource(
  ctx: ActionCtx,
  source: StagedAttachmentSource,
  opts: { appToken: string; tenantToken: string },
): Promise<StagedSourceOutcome> {
  let bytes: ArrayBuffer;
  try {
    bytes = await getStorageBytes(ctx, source.storageId as Id<"_storage">);
  } catch {
    return { kind: "skipped", fileName: source.fileName, storageId: source.storageId };
  }
  if (bytes.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
    return { kind: "skipped", fileName: source.fileName, storageId: source.storageId };
  }
  try {
    const fileToken = await withDriveRateLimitRetry(() =>
      uploadMediaToDrive(ctx, new Blob([bytes]), source.fileName, opts.appToken, opts.tenantToken),
    );
    return { kind: "minted", fileToken, storageId: source.storageId, fileName: source.fileName };
  } catch (e: unknown) {
    console.warn(
      `[drive] deferring attachment "${source.fileName}": ${e instanceof Error ? e.message : String(e)}`,
    );
    return { kind: "deferred", fileName: source.fileName, storageId: source.storageId };
  }
}

interface PreparedDriveSource extends DriveSource {
  bytes: ArrayBuffer;
}

async function prepareDriveSource(
  ctx: ActionCtx,
  source: DriveSource,
): Promise<PreparedDriveSource> {
  const bytes = await getStorageBytes(ctx, source.storageId);
  if (bytes.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
    throw new Error(`Attachment ${source.fileName} exceeds the 20 MB single-shot upload limit`);
  }
  return { ...source, bytes };
}

// PUBLIC action the taskpane calls: relay each staged file to Drive and return
// the minted tokens in input order — exactly the `attachments` shape syncRequest
// consumes. Staged storage objects are deleted after a successful upload.
export const uploadAttachmentsToDrive = action({
  args: {
    sources: v.array(v.object({ storageId: v.id("_storage"), fileName: v.string() })),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ attachments: { fileToken: string }[]; skipped: string[] }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
    if (args.sources.length === 0) return { attachments: [], skipped: [] };

    // Kick the first storage read off alongside the token resolve, but mark it
    // handled so a rejected prepare (a dead/GC'd storageId, or >20 MB) never
    // surfaces as an unhandled rejection while it waits to be consumed below.
    const tenantTokenPromise = resolveFeishuToken(ctx, "tenant");
    const startPrepare = (source: DriveSource): Promise<PreparedDriveSource> => {
      const prepared = prepareDriveSource(ctx, source);
      void prepared.catch(() => {});
      return prepared;
    };
    let nextPrepared: Promise<PreparedDriveSource> | null = startPrepare(args.sources[0]);
    const tenantToken = await tenantTokenPromise;

    // SERIAL, not Promise.all: `medias/upload_all` does not support concurrent
    // calls and is QPS-limited (ADR-0022). We prefetch one storage blob ahead so
    // the current Drive upload overlaps the next Convex storage read.
    // PER-FILE fault tolerance: a dead storageId (a GC'd or already-consumed
    // staged file — e.g. a restored draft pointing at a synced-then-deleted blob)
    // is SKIPPED, never aborting the batch. An attachment failure must never flip
    // the whole sync to syncFailed and discard the user's just-typed notes.
    const attachments: { fileToken: string }[] = [];
    const skipped: string[] = [];
    for (let index = 0; index < args.sources.length; index++) {
      const prepared = nextPrepared!;
      const afterNext = args.sources[index + 1];
      nextPrepared = afterNext ? startPrepare(afterNext) : null;
      const fileName = args.sources[index].fileName;
      try {
        // eslint-disable-next-line react-doctor/async-await-in-loop -- bounded pipeline: each Drive upload depends on this prepared source
        const source = await prepared;
        // eslint-disable-next-line react-doctor/async-await-in-loop -- serial by design: medias/upload_all is 5 QPS-limited (ADR-0022); parallel trips 99991400
        const fileToken = await withDriveRateLimitRetry(() =>
          uploadMediaToDrive(ctx, new Blob([source.bytes]), source.fileName, appToken, tenantToken),
        );
        // eslint-disable-next-line react-doctor/async-await-in-loop -- cleanup tied to this iteration's upload
        await ctx.storage.delete(source.storageId);
        attachments.push({ fileToken });
      } catch (e: unknown) {
        const message = e instanceof Error ? e.message : String(e);
        console.warn(`[drive] skipped attachment "${fileName}": ${message}`);
        skipped.push(fileName);
      }
    }
    return { attachments, skipped };
  },
});
