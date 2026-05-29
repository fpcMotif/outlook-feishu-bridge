// Tests for getStorageBytes — the one exported plain-async helper in storage.ts.
// generateUploadUrl / deleteStorageFile are thin Convex mutation wrappers (no
// branching, single ctx.storage call) and need a live ctx; they are excluded
// from the coverage target per the file's plan note.
//
// getStorageBytes is already a seam (takes ActionCtx as a param), so we drive it
// with a hand-rolled stub ctx + a mocked globalThis.fetch (the mockFetch pattern
// from convex/feishu/client.test.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getStorageBytes } from "./storage";
import type { ActionCtx } from "./_generated/server";
import type { Id } from "./_generated/dataModel";

const STORAGE_ID = "stg_123" as Id<"_storage">;

let realFetch: typeof globalThis.fetch;

beforeEach(() => {
  realFetch = globalThis.fetch;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

/** Stub the slice of ActionCtx getStorageBytes actually touches. */
function makeCtx(getUrl: (id: Id<"_storage">) => Promise<string | null>): ActionCtx {
  return { storage: { getUrl: vi.fn(getUrl) } } as unknown as ActionCtx;
}

describe("getStorageBytes", () => {
  it("returns the fetched ArrayBuffer when getUrl resolves a url", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]).buffer;
    const fetchMock = vi.fn(() =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(payload) } as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ctx = makeCtx(() => Promise.resolve("https://files.example/abc"));
    const bytes = await getStorageBytes(ctx, STORAGE_ID);

    expect(bytes).toBe(payload);
    expect(bytes.byteLength).toBe(4);
  });

  it("calls ctx.storage.getUrl with the passed storageId and fetches that exact url", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) } as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const getUrl = vi.fn(() => Promise.resolve("https://files.example/the-exact-url"));
    const ctx = { storage: { getUrl } } as unknown as ActionCtx;
    await getStorageBytes(ctx, STORAGE_ID);

    expect(getUrl).toHaveBeenCalledWith(STORAGE_ID);
    expect(fetchMock).toHaveBeenCalledWith("https://files.example/the-exact-url");
  });

  it("throws 'Storage file not found' when getUrl returns null", async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ctx = makeCtx(() => Promise.resolve(null));
    await expect(getStorageBytes(ctx, STORAGE_ID)).rejects.toThrow(
      "Storage file not found",
    );
    // Bails before fetching when the file is gone.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns an empty ArrayBuffer (byteLength 0) without throwing for an empty file", async () => {
    const empty = new ArrayBuffer(0);
    const fetchMock = vi.fn(() =>
      Promise.resolve({ arrayBuffer: () => Promise.resolve(empty) } as Response),
    );
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

    const ctx = makeCtx(() => Promise.resolve("https://files.example/empty"));
    const bytes = await getStorageBytes(ctx, STORAGE_ID);

    expect(bytes.byteLength).toBe(0);
  });
});
