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
      await doSleep(backoffMs(attempt));
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

/**
 * Relay each staged Convex File-Storage object to Feishu Drive `medias/upload_all`
 * and return the minted `file_token`s in input order — exactly the `attachments`
 * shape the Bitable create consumes. Staged storage objects are deleted after a
 * successful upload. An optional `tenantToken` is reused (the deferred Base-write
 * worker already holds one) to avoid a redundant token resolve.
 *
 * Extracted from the public action so the END-TO-END path can run server-side in
 * the deferred Base-write worker (ADR-0022 latency optimization): the taskpane now
 * hands raw storageIds straight to `syncRequest`, and the worker runs this
 * `upload_all` right before the idempotent record create — off the submit
 * critical path, which no longer blocks on the serial 5 QPS Drive uploads.
 */
export async function uploadStagedSourcesToDrive(
  ctx: ActionCtx,
  sources: DriveSource[],
  tenantToken?: string,
): Promise<{ attachments: { fileToken: string }[] }> {
  const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
  if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");
  if (sources.length === 0) return { attachments: [] };

  const [token, firstPrepared] = await Promise.all([
    tenantToken ? Promise.resolve(tenantToken) : resolveFeishuToken(ctx, "tenant"),
    prepareDriveSource(ctx, sources[0]),
  ]);
  let nextPrepared: Promise<PreparedDriveSource> | null = null;

  // SERIAL, not Promise.all: `medias/upload_all` does not support concurrent
  // calls and is QPS-limited (ADR-0022). We only prefetch one storage blob
  // ahead so the current Drive upload overlaps the next Convex storage read
  // without holding every selected attachment in action memory at once.
  const attachments: { fileToken: string }[] = [];
  for (let index = 0; index < sources.length; index++) {
    // eslint-disable-next-line react-doctor/async-await-in-loop -- bounded pipeline: each Drive upload depends on this prepared source
    const source = index === 0 ? firstPrepared : await nextPrepared!;
    const afterNext = sources[index + 1];
    nextPrepared = afterNext ? prepareDriveSource(ctx, afterNext) : null;
    // eslint-disable-next-line react-doctor/async-await-in-loop -- serial by design: medias/upload_all is 5 QPS-limited (ADR-0022); parallel trips 99991400
    const fileToken = await withDriveRateLimitRetry(() =>
      uploadMediaToDrive(ctx, new Blob([source.bytes]), source.fileName, appToken, token),
    );
    await ctx.storage.delete(source.storageId);
    attachments.push({ fileToken });
  }
  return { attachments };
}

// PUBLIC action wrapper around uploadStagedSourcesToDrive. Kept as a standalone
// capability (the submit path now relays via syncRequest's attachmentSources, so
// the SPA no longer calls this directly — see requestSync.ts / ADR-0022).
export const uploadAttachmentsToDrive = action({
  args: {
    sources: v.array(v.object({ storageId: v.id("_storage"), fileName: v.string() })),
  },
  handler: (ctx, args): Promise<{ attachments: { fileToken: string }[] }> =>
    uploadStagedSourcesToDrive(ctx, args.sources),
});
