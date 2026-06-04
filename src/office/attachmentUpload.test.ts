/* eslint-disable max-lines-per-function */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  base64ToBlob,
  mimeFromName,
  postBytesToConvex,
  postBytesToConvexWithProgress,
  stageAttachmentSources,
  type AttachmentStagingDeps,
} from "./attachmentUpload";

describe("mimeFromName", () => {
  it("derives the MIME type from the extension (case-insensitive)", () => {
    expect(mimeFromName("Quote.PDF")).toBe("application/pdf");
    expect(mimeFromName("sheet.xlsx")).toBe(
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    );
    expect(mimeFromName("logo.png")).toBe("image/png");
  });

  it("falls back to octet-stream for unknown or missing extensions", () => {
    expect(mimeFromName("data.bin")).toBe("application/octet-stream");
    expect(mimeFromName("noext")).toBe("application/octet-stream");
  });
});

describe("base64ToBlob", () => {
  it("decodes a base64 payload into a typed Blob of the right size", async () => {
    const blob = base64ToBlob(btoa("hello"), "text/plain");
    expect(blob.type).toBe("text/plain");
    expect(blob.size).toBe(5);
    expect(await blob.text()).toBe("hello");
  });
});

describe("stageAttachmentSources", () => {
  it("returns [] and makes no calls when there are no sources", async () => {
    const deps: AttachmentStagingDeps = {
      generateUploadUrl: vi.fn(),
      uploadBytes: vi.fn(),
    };

    await expect(stageAttachmentSources(deps, [])).resolves.toEqual([]);
    expect(deps.generateUploadUrl).not.toHaveBeenCalled();
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });

  it("stages each blob to Convex storage, preserving order (no Drive call)", async () => {
    const a = new Blob(["a"]);
    const b = new Blob(["bb"]);
    const deps: AttachmentStagingDeps = {
      generateUploadUrl: vi
        .fn()
        .mockResolvedValueOnce("https://up/1")
        .mockResolvedValueOnce("https://up/2"),
      uploadBytes: vi
        .fn()
        .mockResolvedValueOnce({ storageId: "st_a" })
        .mockResolvedValueOnce({ storageId: "st_b" }),
    };

    // The submit path now returns staged { storageId, fileName } refs; the Drive
    // upload_all is the backend worker's job (ADR-0022).
    await expect(
      stageAttachmentSources(deps, [
        { name: "a.pdf", blob: a },
        { name: "b.png", blob: b },
      ]),
    ).resolves.toEqual([
      { storageId: "st_a", fileName: "a.pdf" },
      { storageId: "st_b", fileName: "b.png" },
    ]);

    expect(deps.generateUploadUrl).toHaveBeenCalledTimes(2);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(1, "https://up/1", a);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(2, "https://up/2", b);
  });

  it("skips byte upload when a source already has a storageId", async () => {
    const deps: AttachmentStagingDeps = {
      generateUploadUrl: vi.fn(),
      uploadBytes: vi.fn(),
    };

    await expect(
      stageAttachmentSources(deps, [{ name: "cached.pdf", storageId: "st_cached" }]),
    ).resolves.toEqual([{ storageId: "st_cached", fileName: "cached.pdf" }]);

    expect(deps.generateUploadUrl).not.toHaveBeenCalled();
    expect(deps.uploadBytes).not.toHaveBeenCalled();
  });
});

describe("postBytesToConvex", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("POSTs the blob to the upload URL and returns the storageId", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ storageId: "st_1" }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const blob = new Blob(["x"], { type: "application/pdf" });

    await expect(postBytesToConvex("https://up/1", blob)).resolves.toEqual({
      storageId: "st_1",
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe("https://up/1");
    expect(opts.method).toBe("POST");
    expect(opts.headers["Content-Type"]).toBe("application/pdf");
    expect(opts.body).toBe(blob);
  });

  it("throws when the upload response is not ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413 }));

    await expect(
      postBytesToConvex("https://up/1", new Blob(["x"])),
    ).rejects.toThrow(/413/);
  });
});

describe("postBytesToConvexWithProgress", () => {
  class MockXHR {
    status = 200;
    responseText = JSON.stringify({ storageId: "st_xhr" });
    private xhrHandlers: Record<string, () => void> = {};
    private uploadHandlers: Record<string, (e: ProgressEvent) => void> = {};
    // Real XMLHttpRequestUpload / XMLHttpRequest expose addEventListener, not
    // just on<event> setters — mirror that so the production code path is tested.
    upload = {
      addEventListener: (type: string, cb: (e: ProgressEvent) => void): void => {
        this.uploadHandlers[type] = cb;
      },
    };
    open = vi.fn();
    setRequestHeader = vi.fn();
    addEventListener = (type: string, cb: () => void): void => {
      this.xhrHandlers[type] = cb;
    };
    send = vi.fn(() => {
      this.uploadHandlers.progress?.({
        lengthComputable: true,
        loaded: 50,
        total: 100,
      } as ProgressEvent);
      this.xhrHandlers.load?.();
    });
  }

  it("reports upload progress then returns the storageId", async () => {
    const progress = vi.fn();
    const Original = globalThis.XMLHttpRequest;
    vi.stubGlobal("XMLHttpRequest", MockXHR as unknown as typeof XMLHttpRequest);

    await expect(
      postBytesToConvexWithProgress(
        "https://up/1",
        new Blob(["xx"], { type: "application/pdf" }),
        progress,
      ),
    ).resolves.toEqual({ storageId: "st_xhr" });

    expect(progress).toHaveBeenCalledWith(50);
    globalThis.XMLHttpRequest = Original;
  });
});
