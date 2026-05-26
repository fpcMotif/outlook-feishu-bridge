"use node";

import { action } from "../_generated/server";
import { internal } from "../_generated/api";
import { v } from "convex/values";
import { callFeishu } from "./call";
import { getStorageBytes } from "../storage";

export const uploadImageToFeishu = action({
  args: {
    storageId: v.id("_storage"),
    fileName: v.string(),
    contentType: v.string(),
  },
  handler: async (ctx, args) => {
    const fileData = await getStorageBytes(ctx, args.storageId);

    const formData = new FormData();
    formData.append("image_type", "message");
    formData.append("image", new Blob([fileData], { type: args.contentType }), args.fileName);

    const data = await callFeishu<{ image_key?: string }>(ctx, {
      path: "/im/v1/images",
      auth: "tenant",
      label: "Image upload",
      form: formData,
    });

    await ctx.runMutation(internal.storage.deleteStorageFile, {
      storageId: args.storageId,
    });

    return { imageKey: data.image_key ?? "" };
  },
});
