"use node";

import { action, type ActionCtx } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import type { Id } from "../_generated/dataModel";
import { getTenantAccessToken } from "./auth";
import { feishuFetch, FEISHU_BASE } from "./client";
import { getStorageBytes } from "../storage";
import { markdownToBlocks, type FeishuBlock } from "./markdown";

async function createDocument(token: string, title: string): Promise<string> {
  const body: Record<string, string> = { title };
  const folderToken = process.env.FEISHU_DOC_FOLDER_TOKEN;
  if (folderToken) body.folder_token = folderToken;

  const data = await feishuFetch<{ data?: { document?: { document_id: string } } }>({
    url: `${FEISHU_BASE}/docx/v1/documents`,
    token,
    label: "Create document",
    json: body,
  });
  const documentId = data.data?.document?.document_id;
  if (!documentId) throw new Error("Create document returned no document_id");
  return documentId;
}

async function insertBlocks(
  token: string,
  documentId: string,
  children: FeishuBlock[],
): Promise<void> {
  await feishuFetch({
    url: `${FEISHU_BASE}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    token,
    label: "Insert blocks",
    json: { children },
  });
}

type MediaKind = "image" | "file";

// Embedding an image/file is a 3-step dance: create an empty block, upload the
// bytes to Drive against that block, then patch the block with the file token.

async function createEmptyMediaBlock(
  token: string,
  documentId: string,
  kind: MediaKind,
): Promise<string> {
  const child = kind === "image" ? { block_type: 27, image: {} } : { block_type: 23, file: {} };
  const data = await feishuFetch<{
    data?: { children?: { block_id: string; children?: string[] }[] };
  }>({
    url: `${FEISHU_BASE}/docx/v1/documents/${documentId}/blocks/${documentId}/children`,
    token,
    label: `Create ${kind} block`,
    json: { children: [child] },
  });
  const created = data.data?.children?.[0];
  // A file embed is wrapped in a View block (type 33); its real id is the child.
  const blockId = kind === "file" ? (created?.children?.[0] ?? created?.block_id) : created?.block_id;
  if (!blockId) throw new Error(`Create ${kind} block returned no block_id`);
  return blockId;
}

// Drive medias/upload_all caps at 20 MB; above this the chunked flow is required.
const DRIVE_UPLOAD_ALL_MAX = 20 * 1024 * 1024;

type MediaParentType = "docx_image" | "docx_file";

async function uploadMediaAll(
  token: string,
  parentType: MediaParentType,
  parentNode: string,
  fileData: ArrayBuffer,
  fileName: string,
): Promise<string> {
  const formData = new FormData();
  formData.append("file_name", fileName);
  formData.append("parent_type", parentType);
  formData.append("parent_node", parentNode);
  formData.append("size", String(fileData.byteLength));
  formData.append("file", new Blob([fileData]), fileName);

  const data = await feishuFetch<{ data?: { file_token: string } }>({
    url: `${FEISHU_BASE}/drive/v1/medias/upload_all`,
    token,
    label: "Drive media upload",
    form: formData,
  });
  const fileToken = data.data?.file_token;
  if (!fileToken) throw new Error("Drive media upload returned no file_token");
  return fileToken;
}

// Chunked media upload for files over 20 MB (official spec; see ADR-0004):
// upload_prepare -> upload_part x N (block_size-byte blocks, seq 0-indexed) -> upload_finish.
async function uploadMediaChunked(
  token: string,
  parentType: MediaParentType,
  parentNode: string,
  fileData: ArrayBuffer,
  fileName: string,
): Promise<string> {
  const prep = await feishuFetch<{
    data?: { upload_id: string; block_size: number; block_num: number };
  }>({
    url: `${FEISHU_BASE}/drive/v1/medias/upload_prepare`,
    token,
    label: "Drive media prepare",
    json: { file_name: fileName, parent_type: parentType, parent_node: parentNode, size: fileData.byteLength },
  });
  const prepare = prep.data;
  if (!prepare) throw new Error("Drive media prepare returned no data");

  for (let seq = 0; seq < prepare.block_num; seq++) {
    const start = seq * prepare.block_size;
    const chunk = fileData.slice(start, Math.min(start + prepare.block_size, fileData.byteLength));
    const formData = new FormData();
    formData.append("upload_id", prepare.upload_id);
    formData.append("seq", String(seq));
    formData.append("size", String(chunk.byteLength));
    formData.append("file", new Blob([chunk]), fileName);
    await feishuFetch({
      url: `${FEISHU_BASE}/drive/v1/medias/upload_part`,
      token,
      label: `Drive media part ${seq + 1}/${prepare.block_num}`,
      form: formData,
    });
  }

  const fin = await feishuFetch<{ data?: { file_token: string } }>({
    url: `${FEISHU_BASE}/drive/v1/medias/upload_finish`,
    token,
    label: "Drive media finish",
    json: { upload_id: prepare.upload_id, block_num: prepare.block_num },
  });
  const fileToken = fin.data?.file_token;
  if (!fileToken) throw new Error("Drive media finish returned no file_token");
  return fileToken;
}

function uploadMediaToDrive(
  token: string,
  parentType: MediaParentType,
  parentNode: string,
  fileData: ArrayBuffer,
  fileName: string,
): Promise<string> {
  return fileData.byteLength > DRIVE_UPLOAD_ALL_MAX
    ? uploadMediaChunked(token, parentType, parentNode, fileData, fileName)
    : uploadMediaAll(token, parentType, parentNode, fileData, fileName);
}

async function updateMediaBlock(
  token: string,
  documentId: string,
  blockId: string,
  replaceKey: "replace_image" | "replace_file",
  fileToken: string,
): Promise<void> {
  await feishuFetch({
    url: `${FEISHU_BASE}/docx/v1/documents/${documentId}/blocks/${blockId}`,
    method: "PATCH",
    token,
    label: "Update doc block",
    json: { [replaceKey]: { token: fileToken } },
  });
}

async function insertDocMedia(
  ctx: ActionCtx,
  token: string,
  documentId: string,
  storageId: Id<"_storage">,
  fileName: string,
  kind: MediaKind,
): Promise<void> {
  const blockId = await createEmptyMediaBlock(token, documentId, kind);
  const fileData = await getStorageBytes(ctx, storageId);
  const parentType = kind === "image" ? "docx_image" : "docx_file";
  const fileToken = await uploadMediaToDrive(token, parentType, blockId, fileData, fileName);
  const replaceKey = kind === "image" ? "replace_image" : "replace_file";
  await updateMediaBlock(token, documentId, blockId, replaceKey, fileToken);
  await ctx.runMutation(internal.storage.deleteStorageFile, { storageId });
}

const docMediaItem = v.object({ storageId: v.id("_storage"), fileName: v.string() });

export const createFeishuDoc = action({
  args: {
    markdown: v.string(),
    title: v.string(),
    imageStorageIds: v.optional(v.array(docMediaItem)),
    fileStorageIds: v.optional(v.array(docMediaItem)),
  },
  handler: async (ctx: ActionCtx, args) => {
    const token = await getTenantAccessToken(ctx);
    const documentId = await createDocument(token, args.title);

    const blocks = markdownToBlocks(args.markdown);
    for (let i = 0; i < blocks.length; i += 50) {
      await insertBlocks(token, documentId, blocks.slice(i, i + 50));
    }

    for (const img of args.imageStorageIds ?? []) {
      await insertDocMedia(ctx, token, documentId, img.storageId, img.fileName, "image");
    }
    for (const file of args.fileStorageIds ?? []) {
      await insertDocMedia(ctx, token, documentId, file.storageId, file.fileName, "file");
    }

    return { docUrl: `https://feishu.cn/docx/${documentId}`, docToken: documentId };
  },
});
