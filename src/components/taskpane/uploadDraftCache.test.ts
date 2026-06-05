import { beforeEach, describe, expect, it } from "vitest";

import {
  buildUploadDraftKey,
  clearUploadDraft,
  resetUploadDrafts,
  restoreUploadDraft,
  snapshotUploadDraft,
} from "./uploadDraftCache";
import type { UploadedFile } from "./intakeReducer";

function uploadedFile(over: Partial<UploadedFile> = {}): UploadedFile {
  // Spread `over` LAST so an explicit `storageId: undefined` (or `status`) wins
  // over the defaults — a `??` default would silently coerce it back.
  return {
    id: "u1",
    file: new File([new Uint8Array(12)], "quote.pdf", { type: "application/pdf" }),
    rejection: null,
    selected: true,
    status: "complete",
    progress: 100,
    storageId: "st_1",
    uploadError: null,
    ...over,
  };
}

beforeEach(() => {
  resetUploadDrafts();
});

describe("buildUploadDraftKey", () => {
  it("normalizes (lowercases email, trims) and is stable", () => {
    const a = buildUploadDraftKey("ou_a", "  Rep@Fenchem.com ", " conv-1 ");
    const b = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    expect(a).toBe(b);
    expect(a).toContain("rep@fenchem.com");
  });

  it("returns null when email or conversationId is empty or whitespace", () => {
    expect(buildUploadDraftKey("ou_a", "", "conv-1")).toBeNull();
    expect(buildUploadDraftKey("ou_a", "   ", "conv-1")).toBeNull();
    expect(buildUploadDraftKey("ou_a", "rep@fenchem.com", "")).toBeNull();
    expect(buildUploadDraftKey("ou_a", "rep@fenchem.com", "  ")).toBeNull();
  });

  it("isolates by Feishu openId on the SAME shared mailbox", () => {
    const a = buildUploadDraftKey("ou_a", "shared@fenchem.com", "conv-1");
    const b = buildUploadDraftKey("ou_b", "shared@fenchem.com", "conv-1");
    expect(a).not.toBe(b);
  });

  it("distinguishes two users on the same conversation id", () => {
    const a = buildUploadDraftKey("ou_a", "a@x.com", "conv-1");
    const b = buildUploadDraftKey("ou_b", "b@x.com", "conv-1");
    expect(a).not.toBe(b);
  });
});

describe("snapshot + restore round trip", () => {
  it("keeps only complete uploads with a storageId, preserving selected", () => {
    const key = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    snapshotUploadDraft(key, [
      uploadedFile({ id: "ok", selected: false }),
      uploadedFile({ id: "pending", status: "pending", storageId: undefined }),
      uploadedFile({ id: "uploading", status: "uploading", storageId: undefined }),
      uploadedFile({ id: "errored", status: "error", uploadError: "boom" }),
      uploadedFile({ id: "rejected", rejection: "too big" }),
      uploadedFile({ id: "noStorage", status: "complete", storageId: undefined }),
    ]);
    const restored = restoreUploadDraft(key);
    expect(restored.map((u) => u.id)).toEqual(["ok"]);
    expect(restored[0]?.selected).toBe(false);
  });

  it("rehydrates a complete row whose stub File carries the real name/type/size", () => {
    const key = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    snapshotUploadDraft(key, [uploadedFile({ id: "ok" })]);
    const [row] = restoreUploadDraft(key);
    expect(row?.file.name).toBe("quote.pdf");
    expect(row?.file.type).toBe("application/pdf");
    expect(row?.file.size).toBe(12);
    expect(row?.status).toBe("complete");
    expect(row?.progress).toBe(100);
    expect(row?.storageId).toBe("st_1");
    expect(row?.rejection).toBeNull();
    expect(row?.uploadError).toBeNull();
  });

  it("deletes the key when nothing is complete", () => {
    const key = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    snapshotUploadDraft(key, [uploadedFile({ id: "ok" })]);
    snapshotUploadDraft(key, [uploadedFile({ id: "pending", status: "pending", storageId: undefined })]);
    expect(restoreUploadDraft(key)).toEqual([]);
  });

  it("caps a snapshot to the max attachment count", () => {
    const key = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    const many = Array.from({ length: 14 }, (_unused, i) =>
      uploadedFile({ id: `u${i}`, storageId: `st_${i}` }),
    );
    snapshotUploadDraft(key, many);
    expect(restoreUploadDraft(key)).toHaveLength(10);
  });

  it("is a no-op on a null key and returns empty for null/missing keys", () => {
    snapshotUploadDraft(null, [uploadedFile()]);
    expect(restoreUploadDraft(null)).toEqual([]);
    expect(restoreUploadDraft(buildUploadDraftKey("ou_a", "rep@fenchem.com", "never"))).toEqual([]);
  });

  it("clearUploadDraft removes a cached conversation", () => {
    const key = buildUploadDraftKey("ou_a", "rep@fenchem.com", "conv-1");
    snapshotUploadDraft(key, [uploadedFile({ id: "ok" })]);
    clearUploadDraft(key);
    expect(restoreUploadDraft(key)).toEqual([]);
  });

  it("resetUploadDrafts wipes everything (logout)", () => {
    const k1 = buildUploadDraftKey("ou_a", "a@x.com", "conv-1");
    const k2 = buildUploadDraftKey("ou_b", "b@x.com", "conv-2");
    snapshotUploadDraft(k1, [uploadedFile({ id: "ok" })]);
    snapshotUploadDraft(k2, [uploadedFile({ id: "ok2" })]);
    resetUploadDrafts();
    expect(restoreUploadDraft(k1)).toEqual([]);
    expect(restoreUploadDraft(k2)).toEqual([]);
  });
});
