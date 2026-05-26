"use node";

import { internalAction } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callFeishu } from "./call";
import { getStorageBytes } from "../storage";

// A small text PDF rides directly as `pdfBytes` (one CN->US round-trip);
// staging it in Convex File Storage first measured ~3s of pure latency for a
// ~5 KB file. Only a large PDF (rare) comes via `storageId` to stay under the
// 5 MiB Node-action arg cap. Exactly one of pdfBytes/storageId is provided.
// See ADR-0004 / ADR-0005.
export const uploadPdfToFeishu = internalAction({
  args: {
    fileName: v.string(),
    pdfBytes: v.optional(v.bytes()),
    storageId: v.optional(v.id("_storage")),
  },
  handler: async (ctx, args) => {
    const fileData = args.pdfBytes
      ?? (args.storageId ? await getStorageBytes(ctx, args.storageId) : undefined);
    if (!fileData) {
      throw new Error("uploadPdfToFeishu: provide pdfBytes or storageId");
    }

    const formData = new FormData();
    formData.append("file_type", "pdf");
    formData.append("file_name", args.fileName);
    formData.append(
      "file",
      new Blob([fileData], { type: "application/pdf" }),
      args.fileName,
    );

    const data = await callFeishu<{ file_key?: string }>(ctx, {
      path: "/im/v1/files",
      auth: "tenant",
      label: "PDF upload",
      form: formData,
    });

    if (args.storageId) {
      await ctx.runMutation(internal.storage.deleteStorageFile, {
        storageId: args.storageId,
      });
    }

    return { fileKey: data.file_key ?? "" };
  },
});
