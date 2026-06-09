/* eslint-disable max-lines-per-function, max-classes-per-file -- mock XHR variants */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  base64ToBlob,
  isRetryableUploadError,
  isUnreadableFileError,
  mimeFromName,
  postBytesToConvex,
  postBytesToConvexWithProgress,
  readFileBytesWithRetry,
  stageAttachmentSources,
  UNREADABLE_FILE_MESSAGE,
  uploadBlobWithRetry,
  type AttachmentStagingDeps,
} from "./attachmentUpload";

// Mirrors the production transport-error marker (attachmentUpload.ts) so the
// retry helper can be driven without standing up a real failing XHR.
function transportError(message: string): Error {
  const err = new Error(message);
  err.name = "ConvexUploadTransportError";
  return err;
}

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

  it("stages each blob to Convex storage and returns the staged sources in order (no Drive call)", async () => {
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

  it("skips the byte upload when a source already has a storageId (eager intake upload)", async () => {
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

  it("retries a per-source transport failure, re-minting a fresh URL each attempt", async () => {
    const blob = new Blob(["x"]);
    const deps: AttachmentStagingDeps = {
      generateUploadUrl: vi
        .fn()
        .mockResolvedValueOnce("https://up/1")
        .mockResolvedValueOnce("https://up/2"),
      uploadBytes: vi
        .fn()
        .mockRejectedValueOnce(transportError("Convex storage upload failed (network)"))
        .mockResolvedValueOnce({ storageId: "st_ok" }),
    };

    await expect(
      stageAttachmentSources(deps, [{ name: "a.pdf", blob }], {
        backoffMs: 0,
        delay: () => Promise.resolve(),
      }),
    ).resolves.toEqual([{ storageId: "st_ok", fileName: "a.pdf" }]);

    expect(deps.generateUploadUrl).toHaveBeenCalledTimes(2);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(1, "https://up/1", blob);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(2, "https://up/2", blob);
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

  it("tags a fetch transport failure (TypeError) as a retryable network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    const err = await postBytesToConvex("https://up/1", new Blob(["x"])).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe("Convex storage upload failed (network)");
    expect(isRetryableUploadError(err)).toBe(true);
  });

  it("tags an aborted (timed-out) fetch as a retryable timeout error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("aborted", "AbortError")),
    );

    const err = await postBytesToConvex("https://up/1", new Blob(["x"])).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toBe("Convex storage upload timed out");
    expect(isRetryableUploadError(err)).toBe(true);
  });

  it("does NOT tag a non-ok server status as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 413 }));

    const err = await postBytesToConvex("https://up/1", new Blob(["x"])).catch(
      (e: unknown) => e,
    );

    expect((err as Error).message).toMatch(/413/);
    expect(isRetryableUploadError(err)).toBe(false);
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

  // A failing XHR fires `error` (transport) or `timeout`, never `load` — so these
  // must reject as RETRYABLE, distinct from a server `load` with a 4xx/5xx status.
  class FailingXHR {
    static fire: "error" | "timeout" = "error";
    status = 0;
    responseText = "";
    timeout = 0;
    private xhrHandlers: Record<string, () => void> = {};
    upload = { addEventListener: (): void => {} };
    open = vi.fn();
    setRequestHeader = vi.fn();
    addEventListener = (type: string, cb: () => void): void => {
      this.xhrHandlers[type] = cb;
    };
    send = vi.fn(() => {
      this.xhrHandlers[FailingXHR.fire]?.();
    });
  }

  it("rejects with a retryable transport error on the XHR error event", async () => {
    const Original = globalThis.XMLHttpRequest;
    FailingXHR.fire = "error";
    vi.stubGlobal("XMLHttpRequest", FailingXHR as unknown as typeof XMLHttpRequest);

    const err = await postBytesToConvexWithProgress(
      "https://up/1",
      new Blob(["x"]),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toBe("Convex storage upload failed (network)");
    expect(isRetryableUploadError(err)).toBe(true);
    globalThis.XMLHttpRequest = Original;
  });

  it("rejects with a retryable timeout error on the XHR timeout event", async () => {
    const Original = globalThis.XMLHttpRequest;
    FailingXHR.fire = "timeout";
    vi.stubGlobal("XMLHttpRequest", FailingXHR as unknown as typeof XMLHttpRequest);

    const err = await postBytesToConvexWithProgress(
      "https://up/1",
      new Blob(["x"]),
    ).catch((e: unknown) => e);

    expect((err as Error).message).toBe("Convex storage upload timed out");
    expect(isRetryableUploadError(err)).toBe(true);
    globalThis.XMLHttpRequest = Original;
  });
});

describe("uploadBlobWithRetry", () => {
  const blob = new Blob(["x"]);

  it("re-mints a fresh URL and retries after a transport error, then succeeds", async () => {
    const generateUploadUrl = vi
      .fn()
      .mockResolvedValueOnce("https://up/1")
      .mockResolvedValueOnce("https://up/2");
    const postBytes = vi
      .fn()
      .mockRejectedValueOnce(transportError("Convex storage upload failed (network)"))
      .mockResolvedValueOnce({ storageId: "st_ok" });
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      uploadBlobWithRetry(generateUploadUrl, blob, undefined, postBytes, {
        backoffMs: 10,
        delay,
        // Pin the jitter to 0 so the delay is exactly the base.
        random: () => 0,
      }),
    ).resolves.toEqual({ storageId: "st_ok" });

    expect(generateUploadUrl).toHaveBeenCalledTimes(2);
    expect(postBytes).toHaveBeenNthCalledWith(1, "https://up/1", blob, undefined, 60_000);
    expect(postBytes).toHaveBeenNthCalledWith(2, "https://up/2", blob, undefined, 60_000);
    expect(delay).toHaveBeenCalledWith(10);
  });

  it("adds full jitter to the backoff so batched retries de-sync", async () => {
    const generateUploadUrl = vi.fn().mockResolvedValue("https://up/1");
    const postBytes = vi
      .fn()
      .mockRejectedValueOnce(transportError("Convex storage upload failed (network)"))
      .mockRejectedValueOnce(transportError("Convex storage upload failed (network)"))
      .mockResolvedValueOnce({ storageId: "st_ok" });
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      uploadBlobWithRetry(generateUploadUrl, blob, undefined, postBytes, {
        attempts: 3,
        backoffMs: 10,
        delay,
        // 0.5 → half a base of jitter added on top of each exponential step.
        random: () => 0.5,
      }),
    ).resolves.toEqual({ storageId: "st_ok" });

    // attempt 1 base=10 → 10 + floor(0.5*10)=15; attempt 2 base=20 → 20+10=30.
    expect(delay).toHaveBeenNthCalledWith(1, 15);
    expect(delay).toHaveBeenNthCalledWith(2, 30);
  });

  it("does not retry a non-transport error (e.g. a 4xx/5xx load)", async () => {
    const generateUploadUrl = vi.fn().mockResolvedValue("https://up/1");
    const postBytes = vi
      .fn()
      .mockRejectedValue(new Error("Convex storage upload failed (413)"));
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      uploadBlobWithRetry(generateUploadUrl, blob, undefined, postBytes, { delay }),
    ).rejects.toThrow(/413/);

    expect(postBytes).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("gives up after the attempt budget and throws the last transport error", async () => {
    const generateUploadUrl = vi.fn().mockResolvedValue("https://up/1");
    const fatal = transportError("Convex storage upload failed (network)");
    const postBytes = vi.fn().mockRejectedValue(fatal);
    const delay = vi.fn().mockResolvedValue(undefined);

    await expect(
      uploadBlobWithRetry(generateUploadUrl, blob, undefined, postBytes, {
        attempts: 3,
        backoffMs: 5,
        delay,
      }),
    ).rejects.toBe(fatal);

    expect(postBytes).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
  });
});

describe("readFileBytesWithRetry", () => {
  it("returns the bytes on the first successful read (no delay)", async () => {
    const file = { arrayBuffer: vi.fn().mockResolvedValue(new ArrayBuffer(3)) };
    const delay = vi.fn();

    const bytes = await readFileBytesWithRetry(file, { delay });

    expect(bytes.byteLength).toBe(3);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(1);
    expect(delay).not.toHaveBeenCalled();
  });

  it("retries a throwing read (cloud hydration) then succeeds, awaiting backoff", async () => {
    const file = {
      arrayBuffer: vi
        .fn()
        .mockRejectedValueOnce(new Error("NotReadableError"))
        .mockResolvedValueOnce(new ArrayBuffer(5)),
    };
    const delay = vi.fn().mockResolvedValue(undefined);

    const bytes = await readFileBytesWithRetry(file, { backoffMs: 10, delay });

    expect(bytes.byteLength).toBe(5);
    expect(file.arrayBuffer).toHaveBeenCalledTimes(2);
    expect(delay).toHaveBeenCalledWith(10);
  });

  it("gives up after the attempt budget with a tagged, user-actionable error", async () => {
    const file = {
      arrayBuffer: vi.fn().mockRejectedValue(new Error("NotReadableError")),
    };
    const delay = vi.fn().mockResolvedValue(undefined);

    const err = await readFileBytesWithRetry(file, {
      attempts: 3,
      backoffMs: 1,
      delay,
    }).catch((e: unknown) => e);

    expect(file.arrayBuffer).toHaveBeenCalledTimes(3);
    expect(delay).toHaveBeenCalledTimes(2);
    expect(isUnreadableFileError(err)).toBe(true);
    expect((err as Error).message).toBe(UNREADABLE_FILE_MESSAGE);
    expect((err as Error).message).toMatch(/Re-add/);
  });
});
