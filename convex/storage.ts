import { mutation, internalMutation, type ActionCtx } from "./_generated/server";
import { v } from "convex/values";
import type { Id } from "./_generated/dataModel";

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    return await ctx.storage.generateUploadUrl();
  },
});

export const deleteStorageFile = internalMutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, args) => {
    await ctx.storage.delete(args.storageId);
  },
});

/** Fetch a stored file's bytes from an action (throws if it no longer exists). */
export async function getStorageBytes(
  ctx: ActionCtx,
  storageId: Id<"_storage">,
): Promise<ArrayBuffer> {
  const t0 = Date.now();
  const url = await ctx.storage.getUrl(storageId);
  if (!url) throw new Error("Storage file not found");
  const bytes = await (await fetch(url)).arrayBuffer();
  console.log(`[storage] read ${bytes.byteLength}B ${Date.now() - t0}ms`);
  return bytes;
}
