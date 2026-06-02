import { describe, expect, it, vi } from "vitest";

import { gatherAttachmentSources } from "./gatherAttachmentSources";
import type { AttachmentSource } from "../../office/attachmentUpload";
import type { UploadedFile } from "./intakeReducer";

const mailSource = (name: string): AttachmentSource => ({ name, blob: new Blob([name]) });

describe("gatherAttachmentSources", () => {
  it("downloads checked mail attachments then appends valid uploads, in order", async () => {
    const downloadMail = vi.fn((a: { id: string; name: string }) => Promise.resolve(mailSource(a.name)));
    const uploads: UploadedFile[] = [
      { id: "u1", file: new File(["x"], "up.pdf"), rejection: null },
      { id: "u2", file: new File(["x"], "bad.exe"), rejection: "unsupported type" },
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
