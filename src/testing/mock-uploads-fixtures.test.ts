import { describe, expect, it } from "vitest";

import {
  buildMockStagingDeps,
  buildMockUploadedFiles,
  isMockUploadsMode,
} from "./mock-uploads-fixtures";
import {
  isRetryableUploadError,
  UNREADABLE_FILE_MESSAGE,
} from "../office/attachmentUpload";

describe("isMockUploadsMode", () => {
  it("accepts only the known modes", () => {
    expect(isMockUploadsMode("failed-uploads")).toBe(true);
    expect(isMockUploadsMode("failed-uploads-then-ok")).toBe(true);
    expect(isMockUploadsMode("attachments")).toBe(false);
    expect(isMockUploadsMode("")).toBe(false);
    expect(isMockUploadsMode(null)).toBe(false);
  });
});

describe("buildMockUploadedFiles", () => {
  it("seeds a batch exercising every row state, including an unreadable (Re-add) row", () => {
    const files = buildMockUploadedFiles("failed-uploads");
    const errored = files.filter((f) => f.status === "error" && f.rejection === null);
    expect(errored.length).toBeGreaterThan(1);

    // A network-failed row keeps selected:true to prove it is PARKED, not staged.
    expect(errored.every((f) => f.selected)).toBe(true);

    // Exactly the unreadable row carries the cloud message → renders Re-add.
    const unreadable = files.filter((f) => f.uploadError === UNREADABLE_FILE_MESSAGE);
    expect(unreadable).toHaveLength(1);

    // The mix covers complete / uploading / rejected too.
    expect(files.some((f) => f.status === "complete" && f.storageId)).toBe(true);
    expect(files.some((f) => f.status === "uploading")).toBe(true);
    expect(files.some((f) => f.rejection !== null)).toBe(true);
  });
});

describe("buildMockStagingDeps", () => {
  it("always fails generateUploadUrl with a RETRYABLE transport error in failed-uploads mode", async () => {
    const deps = buildMockStagingDeps("failed-uploads");
    const err = await deps.generateUploadUrl().catch((e: unknown) => e);
    expect(isRetryableUploadError(err)).toBe(true);
    // Still retryable on a later attempt — Retry keeps reproducing the failure.
    const err2 = await deps.generateUploadUrl().catch((e: unknown) => e);
    expect(isRetryableUploadError(err2)).toBe(true);
  });

  it("recovers after the first attempt in failed-uploads-then-ok mode", async () => {
    const deps = buildMockStagingDeps("failed-uploads-then-ok");
    await expect(deps.generateUploadUrl()).rejects.toBeTruthy();
    await expect(deps.generateUploadUrl()).resolves.toMatch(/^https?:/);
    await expect(deps.uploadBytes("https://mock.invalid/upload", new Blob(["x"]))).resolves.toEqual(
      expect.objectContaining({ storageId: expect.any(String) }),
    );
  });
});
