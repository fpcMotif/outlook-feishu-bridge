/* eslint-disable max-lines-per-function */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stageAndUploadAttachments = vi.fn();
vi.mock("../../office/attachmentUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../office/attachmentUpload")>();
  return { ...actual, stageAndUploadAttachments: (...args: unknown[]) => stageAndUploadAttachments(...args) };
});

const useAttachmentStaging = vi.fn();
vi.mock("../../hooks/useAttachmentStaging", () => ({
  useAttachmentStaging: () => useAttachmentStaging(),
}));

import { useAttachmentSync } from "./useAttachmentSync";
import type { UploadedFile } from "./intakeReducer";

describe("useAttachmentSync", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("stages valid uploads and returns the minted tokens (no Office host needed)", async () => {
    const deps = { marker: "deps" };
    useAttachmentStaging.mockReturnValue(deps);
    stageAndUploadAttachments.mockResolvedValue([{ fileToken: "tok" }]);

    const { result } = renderHook(() => useAttachmentSync());
    const uploads: UploadedFile[] = [
      { id: "u1", file: new File(["x"], "a.pdf"), rejection: null, selected: true },
    ];

    const out = await result.current([], uploads);

    expect(stageAndUploadAttachments).toHaveBeenCalledWith(deps, [{ name: "a.pdf", blob: uploads[0].file }]);
    expect(out).toEqual({ attachments: [{ fileToken: "tok" }], failed: [] });
  });

  it("best-effort: a selected mail attachment fails to download outside an Office host", async () => {
    useAttachmentStaging.mockReturnValue({});
    stageAndUploadAttachments.mockResolvedValue([]);

    const { result } = renderHook(() => useAttachmentSync());
    const out = await result.current([{ id: "m1", name: "rfq.pdf" }], []);

    expect(out.failed.map((f) => f.name)).toEqual(["rfq.pdf"]);
    expect(stageAndUploadAttachments).not.toHaveBeenCalled();
  });

  it("never throws on a Drive/storage failure: degrades to no tokens + reported failures (#33)", async () => {
    useAttachmentStaging.mockReturnValue({});
    stageAndUploadAttachments.mockRejectedValue(new Error("Drive 500"));

    const { result } = renderHook(() => useAttachmentSync());
    const uploads: UploadedFile[] = [
      { id: "u1", file: new File(["x"], "a.pdf"), rejection: null, selected: true },
    ];

    // The seam must resolve (not reject) so runSync still reaches sync().
    const out = await result.current([], uploads);

    expect(out.attachments).toEqual([]);
    expect(out.failed).toEqual([{ name: "a.pdf", reason: "Drive 500" }]);
  });
});
