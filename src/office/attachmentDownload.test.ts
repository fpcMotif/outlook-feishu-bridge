/* eslint-disable max-lines-per-function */
import { describe, expect, it } from "vitest";

import {
  downloadMailAttachment,
  type AttachmentContentReader,
} from "./attachmentDownload";
import type { OfficeLike } from "./mailItem";

function stubOffice(): OfficeLike {
  return {
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    MailboxEnums: { AttachmentContentFormat: { Base64: "base64", Url: "url" } },
  } as unknown as OfficeLike;
}

function stubItem(result: unknown): AttachmentContentReader {
  return {
    getAttachmentContentAsync: (_id, cb) => cb(result as never),
  };
}

describe("downloadMailAttachment", () => {
  it("resolves to a named Blob (MIME from extension) from a Base64 result", async () => {
    const item = stubItem({
      status: "succeeded",
      value: { format: "base64", content: btoa("PDFDATA") },
    });

    const source = await downloadMailAttachment(stubOffice(), item, {
      id: "a1",
      name: "rfq.pdf",
    });

    expect(source.name).toBe("rfq.pdf");
    expect(source.blob.type).toBe("application/pdf");
    expect(await source.blob.text()).toBe("PDFDATA");
  });

  it("rejects with the Office error message when the result is not Succeeded", async () => {
    const item = stubItem({
      status: "failed",
      error: { message: "AttachmentTypeNotSupported" },
    });

    await expect(
      downloadMailAttachment(stubOffice(), item, { id: "a1", name: "x.pdf" }),
    ).rejects.toThrow(/AttachmentTypeNotSupported/);
  });

  it("rejects an unsupported (non-Base64) attachment format", async () => {
    const item = stubItem({
      status: "succeeded",
      value: { format: "url", content: "https://drive/cloud" },
    });

    await expect(
      downloadMailAttachment(stubOffice(), item, { id: "a1", name: "cloud.pdf" }),
    ).rejects.toThrow(/Unsupported attachment format/);
  });
});
