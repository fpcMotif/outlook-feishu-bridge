/* eslint-disable max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const callFeishu = vi.fn();
const resolveFeishuToken = vi.fn();
vi.mock("./call", () => ({
  callFeishu: (...args: unknown[]) => callFeishu(...args),
  resolveFeishuToken: (...args: unknown[]) => resolveFeishuToken(...args),
}));

const getStorageBytes = vi.fn();
vi.mock("../storage", () => ({
  getStorageBytes: (...args: unknown[]) => getStorageBytes(...args),
}));

import {
  FEISHU_RATE_LIMIT_CODE,
  MAX_MEDIA_UPLOAD_BYTES,
  uploadAttachmentsToDrive,
  uploadMediaToDrive,
  uploadStagedSourcesToDrive,
  withDriveRateLimitRetry,
} from "./drive";
import { FeishuError } from "./client";
import type { ActionCtx } from "../_generated/server";

const rateLimit = (): FeishuError =>
  new FeishuError(FEISHU_RATE_LIMIT_CODE, "request trigger frequency limit", "Drive");

const APP_TOKEN = "appToken123";

type UploadAttachmentsHandler = (
  ctx: ActionCtx,
  args: { sources: { storageId: string; fileName: string }[] },
) => Promise<{ attachments: { fileToken: string }[] }>;

const uploadAttachmentsHandler = (
  uploadAttachmentsToDrive as unknown as { _handler: UploadAttachmentsHandler }
)._handler;

const storageDelete = vi.fn();
const ctx = { storage: { delete: storageDelete } } as unknown as ActionCtx;

const originalAppToken = process.env.FEISHU_BITABLE_APP_TOKEN;

beforeEach(() => {
  callFeishu.mockReset();
  resolveFeishuToken.mockReset();
  resolveFeishuToken.mockResolvedValue("tenant-token");
  getStorageBytes.mockReset();
  storageDelete.mockReset();
  storageDelete.mockResolvedValue(undefined);
  process.env.FEISHU_BITABLE_APP_TOKEN = APP_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (originalAppToken === undefined) delete process.env.FEISHU_BITABLE_APP_TOKEN;
  else process.env.FEISHU_BITABLE_APP_TOKEN = originalAppToken;
});

describe("uploadMediaToDrive", () => {
  it("builds the upload_all FormData and returns the file_token", async () => {
    callFeishu.mockResolvedValueOnce({ file_token: "boxcnFILE" });
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const blob = new Blob([bytes]);

    await expect(
      uploadMediaToDrive(ctx, blob, "quote.pdf", APP_TOKEN),
    ).resolves.toBe("boxcnFILE");

    expect(callFeishu).toHaveBeenCalledTimes(1);
    const [passedCtx, opts] = callFeishu.mock.calls[0];
    expect(passedCtx).toBe(ctx);
    expect(opts.path).toBe("/drive/v1/medias/upload_all");
    expect(opts.method).toBe("POST");
    expect(opts.auth).toBe("tenant");

    const form: FormData = opts.form;
    expect(form.get("file_name")).toBe("quote.pdf");
    expect(form.get("parent_type")).toBe("bitable_file");
    expect(form.get("parent_node")).toBe(APP_TOKEN);
    expect(form.get("size")).toBe(String(blob.size));
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("throws an error mentioning file_token when the response lacks one", async () => {
    callFeishu.mockResolvedValueOnce({});
    const blob = new Blob([new Uint8Array([1])]);

    await expect(
      uploadMediaToDrive(ctx, blob, "x.pdf", APP_TOKEN),
    ).rejects.toThrow(/file_token/);
  });
});

describe("uploadAttachmentsToDrive action", () => {
  it("uploads each staged blob in order, deletes staging, and returns tokens in order", async () => {
    getStorageBytes
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer)
      .mockResolvedValueOnce(new Uint8Array([9, 9]).buffer);
    callFeishu
      .mockResolvedValueOnce({ file_token: "tokenA" })
      .mockResolvedValueOnce({ file_token: "tokenB" });

    await expect(
      uploadAttachmentsHandler(ctx, {
        sources: [
          { storageId: "kg_a", fileName: "a.pdf" },
          { storageId: "kg_b", fileName: "b.xlsx" },
        ],
      }),
    ).resolves.toEqual({
      attachments: [{ fileToken: "tokenA" }, { fileToken: "tokenB" }],
    });

    expect(getStorageBytes).toHaveBeenNthCalledWith(1, ctx, "kg_a");
    expect(getStorageBytes).toHaveBeenNthCalledWith(2, ctx, "kg_b");
    expect(resolveFeishuToken).toHaveBeenCalledTimes(1);
    expect(resolveFeishuToken).toHaveBeenCalledWith(ctx, "tenant");
    expect(callFeishu).toHaveBeenCalledTimes(2);
    expect(callFeishu.mock.calls[0][1].token).toBe("tenant-token");
    expect(callFeishu.mock.calls[1][1].token).toBe("tenant-token");
    expect(storageDelete).toHaveBeenNthCalledWith(1, "kg_a");
    expect(storageDelete).toHaveBeenNthCalledWith(2, "kg_b");
  });

  it("prefetches only one staged blob ahead of the serial Drive upload", async () => {
    let resolveFirstUpload: (value: { file_token: string }) => void = () => {};
    const firstUpload = new Promise<{ file_token: string }>((resolve) => {
      resolveFirstUpload = resolve;
    });
    getStorageBytes.mockResolvedValue(new Uint8Array([1]).buffer);
    callFeishu
      .mockReturnValueOnce(firstUpload)
      .mockResolvedValueOnce({ file_token: "tokenB" })
      .mockResolvedValueOnce({ file_token: "tokenC" });

    const pending = uploadAttachmentsHandler(ctx, {
      sources: [
        { storageId: "kg_a", fileName: "a.pdf" },
        { storageId: "kg_b", fileName: "b.xlsx" },
        { storageId: "kg_c", fileName: "c.png" },
      ],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(getStorageBytes).toHaveBeenCalledTimes(2);
    expect(callFeishu).toHaveBeenCalledTimes(1);

    resolveFirstUpload({ file_token: "tokenA" });
    await expect(pending).resolves.toEqual({
      attachments: [{ fileToken: "tokenA" }, { fileToken: "tokenB" }, { fileToken: "tokenC" }],
    });
    expect(getStorageBytes).toHaveBeenCalledTimes(3);
  });

  it("rejects an oversized staged file BEFORE uploading or deleting", async () => {
    const oversized = new Uint8Array(MAX_MEDIA_UPLOAD_BYTES + 1).buffer;
    getStorageBytes.mockResolvedValueOnce(oversized);

    await expect(
      uploadAttachmentsHandler(ctx, {
        sources: [{ storageId: "kg_big", fileName: "huge.pdf" }],
      }),
    ).rejects.toThrow(/20 MB/);

    expect(callFeishu).not.toHaveBeenCalled();
    expect(storageDelete).not.toHaveBeenCalled();
  });

  it("does not delete any staged file when a later Drive upload fails", async () => {
    getStorageBytes.mockResolvedValue(new Uint8Array([1]).buffer);
    callFeishu
      .mockResolvedValueOnce({ file_token: "tokenA" })
      .mockRejectedValueOnce(new Error("Drive failed"));

    await expect(
      uploadAttachmentsHandler(ctx, {
        sources: [
          { storageId: "kg_a", fileName: "a.pdf" },
          { storageId: "kg_b", fileName: "b.xlsx" },
        ],
      }),
    ).rejects.toThrow("Drive failed");

    expect(storageDelete).not.toHaveBeenCalled();
  });

  it("can leave staged storage for the worker until the Base row is created", async () => {
    getStorageBytes
      .mockResolvedValueOnce(new Uint8Array([1, 2, 3]).buffer)
      .mockResolvedValueOnce(new Uint8Array([9, 9]).buffer);
    callFeishu
      .mockResolvedValueOnce({ file_token: "tokenA" })
      .mockResolvedValueOnce({ file_token: "tokenB" });

    await expect(
      uploadStagedSourcesToDrive(
        ctx,
        [
          { storageId: "kg_a", fileName: "a.pdf" },
          { storageId: "kg_b", fileName: "b.xlsx" },
        ] as never,
        { deleteAfterUpload: false },
      ),
    ).resolves.toEqual({
      attachments: [{ fileToken: "tokenA" }, { fileToken: "tokenB" }],
    });

    expect(storageDelete).not.toHaveBeenCalled();
  });

  it("throws when FEISHU_BITABLE_APP_TOKEN is unset", async () => {
    delete process.env.FEISHU_BITABLE_APP_TOKEN;

    await expect(
      uploadAttachmentsHandler(ctx, {
        sources: [{ storageId: "kg_a", fileName: "a.pdf" }],
      }),
    ).rejects.toThrow(/FEISHU_BITABLE_APP_TOKEN/);

    expect(callFeishu).not.toHaveBeenCalled();
    expect(getStorageBytes).not.toHaveBeenCalled();
  });
});

describe("withDriveRateLimitRetry", () => {
  const noSleep = (): Promise<void> => Promise.resolve();

  it("returns immediately on success without retrying", async () => {
    const upload = vi.fn().mockResolvedValue("tok_1");
    await expect(
      withDriveRateLimitRetry(upload, { sleep: noSleep }),
    ).resolves.toBe("tok_1");
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("retries the 99991400 frequency-limit then succeeds", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue("tok_ok");
    await expect(
      withDriveRateLimitRetry(upload, { sleep: noSleep }),
    ).resolves.toBe("tok_ok");
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("gives up after maxAttempts and rethrows the rate-limit error", async () => {
    const err = rateLimit();
    const upload = vi.fn().mockRejectedValue(err);
    await expect(
      withDriveRateLimitRetry(upload, { maxAttempts: 3, sleep: noSleep }),
    ).rejects.toBe(err);
    expect(upload).toHaveBeenCalledTimes(3);
  });

  it("does NOT retry a non-rate-limit Feishu error (FieldNameNotFound)", async () => {
    const err = new FeishuError(1254045, "FieldNameNotFound", "Drive");
    const upload = vi.fn().mockRejectedValue(err);
    await expect(
      withDriveRateLimitRetry(upload, { sleep: noSleep }),
    ).rejects.toBe(err);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry a generic (non-Feishu) Error", async () => {
    const err = new Error("network down");
    const upload = vi.fn().mockRejectedValue(err);
    await expect(
      withDriveRateLimitRetry(upload, { sleep: noSleep }),
    ).rejects.toBe(err);
    expect(upload).toHaveBeenCalledTimes(1);
  });

  it("feeds the attempt index to backoffMs", async () => {
    const backoffMs = vi.fn((attempt: number) => attempt);
    const upload = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue("ok");
    await withDriveRateLimitRetry(upload, { sleep: noSleep, backoffMs });
    expect(backoffMs).toHaveBeenCalledWith(0);
  });

  it("uses the real backoff sleep between retries (smoke)", async () => {
    const upload = vi
      .fn()
      .mockRejectedValueOnce(rateLimit())
      .mockResolvedValue("ok");
    await expect(
      withDriveRateLimitRetry(upload, { backoffMs: () => 1 }),
    ).resolves.toBe("ok");
    expect(upload).toHaveBeenCalledTimes(2);
  });
});
