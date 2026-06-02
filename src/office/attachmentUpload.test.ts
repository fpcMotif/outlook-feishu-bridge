/* eslint-disable max-lines-per-function */
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  base64ToBlob,
  mimeFromName,
  postBytesToConvex,
  stageAndUploadAttachments,
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

describe("stageAndUploadAttachments", () => {
  it("returns [] and makes no calls when there are no sources", async () => {
    const deps: AttachmentStagingDeps = {
      generateUploadUrl: vi.fn(),
      uploadBytes: vi.fn(),
      uploadToDrive: vi.fn(),
    };

    await expect(stageAndUploadAttachments(deps, [])).resolves.toEqual([]);
    expect(deps.generateUploadUrl).not.toHaveBeenCalled();
    expect(deps.uploadToDrive).not.toHaveBeenCalled();
  });

  it("stages each blob then mints Drive tokens in one backend call, preserving order", async () => {
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
      uploadToDrive: vi.fn().mockResolvedValue({
        attachments: [{ fileToken: "tok_a" }, { fileToken: "tok_b" }],
      }),
    };

    await expect(
      stageAndUploadAttachments(deps, [
        { name: "a.pdf", blob: a },
        { name: "b.png", blob: b },
      ]),
    ).resolves.toEqual([{ fileToken: "tok_a" }, { fileToken: "tok_b" }]);

    expect(deps.generateUploadUrl).toHaveBeenCalledTimes(2);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(1, "https://up/1", a);
    expect(deps.uploadBytes).toHaveBeenNthCalledWith(2, "https://up/2", b);
    expect(deps.uploadToDrive).toHaveBeenCalledTimes(1);
    expect(deps.uploadToDrive).toHaveBeenCalledWith([
      { storageId: "st_a", fileName: "a.pdf" },
      { storageId: "st_b", fileName: "b.png" },
    ]);
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
