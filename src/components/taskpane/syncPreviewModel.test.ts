import { describe, expect, it } from "vitest";

import type { AttachmentInfo } from "../../office/mailItem";
import {
  buildSyncPreviewNotes,
  selectedAttachmentsForPreview,
  summarizeRequestNotes,
  SYNC_PREVIEW_MULTI_NOTE_MAX,
  SYNC_PREVIEW_SINGLE_NOTE_MAX,
  syncPreviewAttachmentsVisible,
  syncPreviewRowSynced,
  truncatePreviewNoteText,
} from "./syncPreviewModel";

describe("syncPreviewModel", () => {
  it("maps all fulfilled requests without capping note count", () => {
    const filled = [
      { id: "a", title: "Sample", note: "First" },
      { id: "b", title: "Quotation", note: "Second" },
      { id: "c", title: "R&D Support", note: "Third" },
      { id: "d", title: "Extra", note: "Fourth" },
    ];
    expect(buildSyncPreviewNotes(filled)).toHaveLength(4);
    expect(buildSyncPreviewNotes(filled)[3]).toMatchObject({ label: "Extra", text: "Fourth" });
  });

  it("collects selected mail attachments and uploads in order", () => {
    const mail: AttachmentInfo[] = [
      { id: "m1", name: "rfq.pdf", attachmentType: "file", size: 1, isInline: false },
      { id: "m2", name: "skip.docx", attachmentType: "file", size: 1, isInline: false },
    ];
    const preview = selectedAttachmentsForPreview(mail, {
      selectedAttachmentIds: ["m1"],
      uploadedFiles: [
        {
          id: "u1",
          file: new File(["x"], "addendum.pdf", { type: "application/pdf" }),
          rejection: null,
          selected: true,
        },
        {
          id: "u2",
          file: new File(["x"], "draft.docx", { type: "application/msword" }),
          rejection: null,
          selected: false,
        },
      ],
    });
    expect(preview).toEqual([{ name: "rfq.pdf" }, { name: "addendum.pdf" }]);
  });

  it("gates preview animation thresholds", () => {
    expect(syncPreviewRowSynced(33)).toBe(false);
    expect(syncPreviewRowSynced(34)).toBe(true);
    expect(syncPreviewAttachmentsVisible(51)).toBe(false);
    expect(syncPreviewAttachmentsVisible(52)).toBe(true);
  });

  it("summarizes a single note as one teaser line", () => {
    const summary = summarizeRequestNotes([
      { id: "a", label: "Sample", text: "  Need   silica  for trials.  " },
    ]);
    expect(summary).toMatchObject({
      sectionLabel: "Request note",
      countLabel: null,
      previewLines: ["Need silica for trials."],
    });
  });

  it("truncates long single notes at a word boundary", () => {
    const long = "word ".repeat(40).trim();
    const summary = summarizeRequestNotes([{ id: "a", label: "Sample", text: long }]);
    expect(summary.previewLines[0]).toMatch(/…$/);
    expect(summary.previewLines[0].length).toBeLessThanOrEqual(SYNC_PREVIEW_SINGLE_NOTE_MAX + 1);
    expect(truncatePreviewNoteText(long, SYNC_PREVIEW_SINGLE_NOTE_MAX)).toMatch(/…$/);
  });

  it("summarizes multiple notes without request-type labels", () => {
    const summary = summarizeRequestNotes([
      { id: "a", label: "Sample", text: "First note about silica." },
      { id: "b", label: "Quotation", text: "Second note about pricing." },
      { id: "c", label: "R&D Support", text: "Third note about stability." },
    ]);
    expect(summary.sectionLabel).toBe("Request notes");
    expect(summary.countLabel).toBe("3 notes");
    expect(summary.previewLines).toEqual([
      "First note about silica.",
      "Second note about pricing.",
      "Third note about stability.",
    ]);
    expect(summary.previewLines.join(" ")).not.toMatch(/sample|quotation|r&d/i);
  });

  it("caps multi-note previews and surfaces overflow", () => {
    const notes = Array.from({ length: 5 }, (_, index) => ({
      id: `n${index}`,
      label: "Sample",
      text: `Note number ${index + 1} with enough text to matter.`,
    }));
    const summary = summarizeRequestNotes(notes);
    expect(summary.previewLines).toHaveLength(4);
    expect(summary.previewLines[3]).toBe("+2 more");
    expect(summary.previewLines[0].length).toBeLessThanOrEqual(SYNC_PREVIEW_MULTI_NOTE_MAX + 1);
  });

  it("uses placeholder copy when every note is empty", () => {
    expect(
      summarizeRequestNotes([{ id: "a", label: "Sample", text: "   " }]),
    ).toMatchObject({
      sectionLabel: "Request note",
      previewLines: ["Ready to write your note to Base."],
    });
  });
});
