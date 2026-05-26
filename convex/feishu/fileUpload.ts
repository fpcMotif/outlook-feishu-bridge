"use node";

import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callFeishu } from "./call";
import { getStorageBytes } from "../storage";

const FEISHU_FILE_TYPE_MAP: Record<string, string> = {
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "ppt",
  "video/mp4": "mp4",
  "audio/opus": "opus",
};

function resolveFeishuFileType(contentType: string): string {
  return FEISHU_FILE_TYPE_MAP[contentType] ?? "stream";
}

export const uploadAttachmentToFeishu = action({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const fileData = await getStorageBytes(ctx, args.storageId);

    const formData = new FormData();
    formData.append("file_type", resolveFeishuFileType(args.contentType));
    formData.append("file_name", args.fileName);
    formData.append("file", new Blob([fileData], { type: args.contentType }), args.fileName);

    const data = await callFeishu<{ file_key?: string }>(ctx, {
      path: "/im/v1/files",
      auth: "tenant",
      label: "Attachment upload",
      form: formData,
    });

    await ctx.runMutation(internal.storage.deleteStorageFile, {
      storageId: args.storageId,
    });

    return { fileKey: data.file_key ?? "" };
  },
});
