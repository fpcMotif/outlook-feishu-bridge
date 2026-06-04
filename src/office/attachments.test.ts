import { describe, expect, it } from "vitest";

import type { AttachmentInfo } from "./mailItem";
import {
  ALLOWED_UPLOAD_EXTENSIONS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_COUNT,
  UPLOAD_MIME_BY_EXTENSION,
  fileExtension,
  formatAttachmentMeta,
  formatBytes,
  isAllowedUploadName,
  selectableMailAttachments,
  uploadRejectionReason,
} from "./attachments";

const att = (over: Partial<AttachmentInfo>): AttachmentInfo => ({
  id: "a",
  name: "file.pdf",
  attachmentType: "file",
  size: 100,
  isInline: false,
  ...over,
});

describe("selectableMailAttachments", () => {
  // ADR-0022: the picker offers only real file attachments — inline images and
  // cloud/item attachment types are dropped.
  it("keeps real file attachments and drops inline + cloud/item types", () => {
    const input = [
      att({ id: "pdf", attachmentType: "file", isInline: false }),
      att({ id: "inline-img", attachmentType: "file", isInline: true }),
      att({ id: "cloud", attachmentType: "cloud", isInline: false }),
      att({ id: "item", attachmentType: "item", isInline: false }),
    ];
    expect(selectableMailAttachments(input).map((a) => a.id)).toEqual(["pdf"]);
  });

  it("returns an empty array when there are no attachments", () => {
    expect(selectableMailAttachments([])).toEqual([]);
  });
});

describe("upload validation (ADR-0022 decision #4)", () => {
  it("caps at 20 MB per file and 10 files total", () => {
    expect(MAX_ATTACHMENT_BYTES).toBe(20 * 1024 * 1024);
    expect(MAX_ATTACHMENT_COUNT).toBe(10);
  });

  it("extracts the lowercased final extension", () => {
    expect(fileExtension("Quote.PDF")).toBe("pdf");
    expect(fileExtension("archive.tar.gz")).toBe("gz");
    expect(fileExtension("noext")).toBe("");
    expect(fileExtension(".hidden")).toBe("hidden");
  });

  it("derives the allow-list from the single MIME source of truth", () => {
    expect(ALLOWED_UPLOAD_EXTENSIONS).toEqual(Object.keys(UPLOAD_MIME_BY_EXTENSION));
  });

  it("allows pdf / excel / word / image uploads and rejects the rest", () => {
    for (const ok of ["q.pdf", "sheet.xlsx", "table.csv", "doc.docx", "pic.PNG", "photo.jpeg"]) {
      expect(isAllowedUploadName(ok)).toBe(true);
    }
    for (const bad of ["evil.exe", "data.zip", "script.js", "noext"]) {
      expect(isAllowedUploadName(bad)).toBe(false);
    }
  });

  it("returns no rejection reason for a valid file", () => {
    expect(uploadRejectionReason({ name: "q.pdf", size: 1000 })).toBeNull();
  });

  it("rejects an unsupported type, then an oversize file, each with a short reason", () => {
    expect(uploadRejectionReason({ name: "evil.exe", size: 10 })).toMatch(/unsupported/i);
    expect(uploadRejectionReason({ name: "big.pdf", size: MAX_ATTACHMENT_BYTES + 1 })).toMatch(/20 MB/);
  });

  it("formats bytes for the row label", () => {
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("formatAttachmentMeta shows size only", () => {
    expect(formatAttachmentMeta(1536)).toBe("1.5 KB");
    expect(formatAttachmentMeta(1536)).not.toMatch(/\d{4}|jan|feb|may/i);
  });
});
