/* eslint-disable max-lines-per-function */
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const useMutation = vi.fn();
const useAction = vi.fn();
vi.mock("convex/react", () => ({
  useMutation: (...args: unknown[]) => useMutation(...args),
  useAction: (...args: unknown[]) => useAction(...args),
}));

import { postBytesToConvex } from "../office/attachmentUpload";
import { useAttachmentStaging } from "./useAttachmentStaging";

describe("useAttachmentStaging", () => {
  it("assembles the staging deps and maps sources into the Drive action call", async () => {
    const generate = vi.fn().mockResolvedValue("https://up/1");
    const drive = vi.fn().mockResolvedValue({ attachments: [{ fileToken: "tok" }] });
    useMutation.mockReturnValue(generate);
    useAction.mockReturnValue(drive);

    const { result } = renderHook(() => useAttachmentStaging());
    const deps = result.current;

    // uploadBytes is the real Convex storage POST helper.
    expect(deps.uploadBytes).toBe(postBytesToConvex);

    // generateUploadUrl delegates to the mutation.
    await expect(deps.generateUploadUrl()).resolves.toBe("https://up/1");

    // uploadToDrive forwards the staged sources under the action's { sources } arg.
    await expect(
      deps.uploadToDrive([{ storageId: "st_1", fileName: "a.pdf" }]),
    ).resolves.toEqual({ attachments: [{ fileToken: "tok" }] });
    expect(drive).toHaveBeenCalledWith({
      sources: [{ storageId: "st_1", fileName: "a.pdf" }],
    });
  });
});
