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
import { callFeishu } from "./call";
import { getStorageBytes } from "../storage";

// ADR-0022 decision #4: single-shot only. Reject any file larger than 20 MiB
// before uploading — the chunked upload_prepare path is not implemented in v1.
export const MAX_MEDIA_UPLOAD_BYTES = 20 * 1024 * 1024;

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
    form,
    label: "Feishu Drive media upload_all",
  });
  if (!data.file_token) {
    throw new Error("Feishu Drive upload_all returned no file_token");
  }
  return data.file_token;
}

// PUBLIC action the taskpane calls: relay each staged file to Drive and return
// the minted tokens in input order — exactly the `attachments` shape syncRequest
// consumes. Staged storage objects are deleted after a successful upload.
export const uploadAttachmentsToDrive = action({
  args: {
    sources: v.array(v.object({ storageId: v.id("_storage"), fileName: v.string() })),
  },
  handler: async (ctx, args): Promise<{ attachments: { fileToken: string }[] }> => {
    const appToken = process.env.FEISHU_BITABLE_APP_TOKEN;
    if (!appToken) throw new Error("FEISHU_BITABLE_APP_TOKEN must be set");

    const attachments: { fileToken: string }[] = [];
    for (const source of args.sources) {
      const bytes = await getStorageBytes(ctx, source.storageId);
      if (bytes.byteLength > MAX_MEDIA_UPLOAD_BYTES) {
        throw new Error(`Attachment ${source.fileName} exceeds the 20 MB single-shot upload limit`);
      }
      const fileToken = await uploadMediaToDrive(ctx, new Blob([bytes]), source.fileName, appToken);
      await ctx.storage.delete(source.storageId);
      attachments.push({ fileToken });
    }
    return { attachments };
  },
});
