/* eslint-disable max-lines-per-function */
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const stageAttachmentSources = vi.fn();
vi.mock("../../office/attachmentUpload", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../office/attachmentUpload")>();
  return { ...actual, stageAttachmentSources: (...args: unknown[]) => stageAttachmentSources(...args) };
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

  it("stages valid uploads and returns the staged sources (no Office host needed)", async () => {
    const deps = { marker: "deps" };
    useAttachmentStaging.mockReturnValue(deps);
    stageAttachmentSources.mockResolvedValue([{ storageId: "st_a", fileName: "a.pdf" }]);

    const { result } = renderHook(() => useAttachmentSync());
    const uploads: UploadedFile[] = [
      { id: "u1", file: new File(["x"], "a.pdf"), rejection: null, selected: true },
    ];

    const out = await result.current([], uploads);

    expect(stageAttachmentSources).toHaveBeenCalledWith(deps, [{ name: "a.pdf", blob: uploads[0].file }]);
    // The submit path returns staged storageIds; the Drive mint is the deferred
    // Attachment Fill worker's job (ADR-0027).
    expect(out).toEqual({ sources: [{ storageId: "st_a", fileName: "a.pdf" }], failed: [] });
  });

  it("best-effort: a selected mail attachment fails to download outside an Office host", async () => {
    useAttachmentStaging.mockReturnValue({});
    stageAttachmentSources.mockResolvedValue([]);

    const { result } = renderHook(() => useAttachmentSync());
    const out = await result.current([{ id: "m1", name: "rfq.pdf" }], []);

    expect(out.failed.map((f) => f.name)).toEqual(["rfq.pdf"]);
    expect(stageAttachmentSources).not.toHaveBeenCalled();
  });
});
