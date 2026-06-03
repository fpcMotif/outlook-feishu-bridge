import { describe, expect, it, vi } from "vitest";

import { gatherAttachmentSources } from "./gatherAttachmentSources";
import type { AttachmentSource } from "../../office/attachmentUpload";
import type { UploadedFile } from "./intakeReducer";

const mailSource = (name: string): AttachmentSource => ({ name, blob: new Blob([name]) });

describe("gatherAttachmentSources", () => {
  it("downloads checked mail attachments then appends valid uploads, in order", async () => {
    const downloadMail = vi.fn((a: { id: string; name: string }) => Promise.resolve(mailSource(a.name)));
    const uploads: UploadedFile[] = [
      { id: "u1", file: new File(["x"], "up.pdf"), rejection: null, selected: true },
      { id: "u2", file: new File(["x"], "skipped.pdf"), rejection: null, selected: false },
      { id: "u3", file: new File(["x"], "bad.exe"), rejection: "unsupported type", selected: false },
    ];

    const { sources, failed } = await gatherAttachmentSources(
      downloadMail,
      [{ id: "m1", name: "rfq.pdf" }],
      uploads,
    );

    expect(failed).toEqual([]);
    expect(sources.map((s) => s.name)).toEqual(["rfq.pdf", "up.pdf"]);
    expect(downloadMail).toHaveBeenCalledTimes(1);
  });

  it("reuses a completed eager storageId instead of re-reading the File blob", async () => {
    const downloadMail = vi.fn();
    const uploads: UploadedFile[] = [
      {
        id: "u1",
        file: new File(["x"], "up.pdf"),
        rejection: null,
        selected: true,
        status: "complete",
        storageId: "st_cached",
      },
    ];

    const { sources } = await gatherAttachmentSources(downloadMail, [], uploads);

    expect(sources).toEqual([{ name: "up.pdf", storageId: "st_cached" }]);
    expect(downloadMail).not.toHaveBeenCalled();
  });

  it("records failed eager uploads without staging them", async () => {
    const { sources, failed } = await gatherAttachmentSources(
      vi.fn(),
      [],
      [
        {
          id: "u1",
          file: new File(["x"], "up.pdf"),
          rejection: null,
          selected: true,
          status: "error",
          uploadError: "network",
        },
      ],
    );

    expect(sources).toEqual([]);
    expect(failed).toEqual([{ name: "up.pdf", reason: "network" }]);
  });

  it("records a failed mail download (best-effort) and keeps the successes", async () => {
    const downloadMail = vi
      .fn()
      .mockRejectedValueOnce(new Error("AttachmentTypeNotSupported"))
      .mockResolvedValueOnce(mailSource("ok.pdf"));

    const { sources, failed } = await gatherAttachmentSources(
      downloadMail,
      [
        { id: "m1", name: "bad.pdf" },
        { id: "m2", name: "ok.pdf" },
      ],
      [],
    );

    expect(sources.map((s) => s.name)).toEqual(["ok.pdf"]);
    expect(failed).toEqual([{ name: "bad.pdf", reason: "AttachmentTypeNotSupported" }]);
  });
});
