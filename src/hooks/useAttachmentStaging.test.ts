/* eslint-disable max-lines-per-function */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useMutation = vi.fn();
vi.mock("convex/react", () => ({
  useMutation: (...args: unknown[]) => useMutation(...args),
}));

import { postBytesToConvex } from "../office/attachmentUpload";
import { useAttachmentStaging } from "./useAttachmentStaging";

describe("useAttachmentStaging", () => {
  it("assembles the staging deps (storage mint + byte POST only)", async () => {
    const generate = vi.fn().mockResolvedValue("https://up/1");
    useMutation.mockReturnValue(generate);

    const { result } = renderHook(() => useAttachmentStaging());
    const deps = result.current;

    // uploadBytes is the real Convex storage POST helper.
    expect(deps.uploadBytes).toBe(postBytesToConvex);

    // generateUploadUrl delegates to the mutation.
    await expect(deps.generateUploadUrl()).resolves.toBe("https://up/1");

    // The Drive token-minting action is no longer a submit-path dependency — the
    // upload_all moved into the deferred Base-write worker (ADR-0022).
    expect("uploadToDrive" in deps).toBe(false);
  });
});
