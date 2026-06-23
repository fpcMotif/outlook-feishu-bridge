import { describe, expect, it } from "vitest";

import {
  attachmentCount,
  buildUploadedFiles,
  canAddMore,
  filterDuplicateUploadFiles,
  occupiesSlot,
} from "./attachmentSelection";
import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { UploadedFile } from "./intakeReducer";

const upload = (name: string, rejection: string | null): UploadedFile => ({
  id: name,
  file: new File(["x"], name),
  rejection,
  selected: rejection === null,
});

describe("occupiesSlot", () => {
  it("counts a selected upload with no status yet, or complete/in-flight", () => {
    expect(occupiesSlot(upload("a.pdf", null))).toBe(true);
    expect(occupiesSlot({ ...upload("a.pdf", null), status: "complete" })).toBe(true);
    expect(occupiesSlot({ ...upload("a.pdf", null), status: "uploading" })).toBe(true);
    expect(occupiesSlot({ ...upload("a.pdf", null), status: "pending" })).toBe(true);
  });

  it("never counts a failed, rejected, or deselected upload", () => {
    expect(occupiesSlot({ ...upload("a.pdf", null), status: "error" })).toBe(false);
    expect(occupiesSlot(upload("c.exe", "unsupported type"))).toBe(false);
    expect(occupiesSlot({ ...upload("a.pdf", null), selected: false })).toBe(false);
  });
});

describe("attachmentCount", () => {
  it("counts checked mail ids plus selected valid uploads, excluding rejected and deselected uploads", () => {
    const uploads = [
      upload("a.pdf", null),
      { ...upload("b.png", null), selected: false },
      upload("c.exe", "unsupported type"),
    ];
    expect(attachmentCount(["m1", "m2"], uploads)).toBe(3);
  });

  it("does not count a selected upload that failed (it is parked, not staged)", () => {
    const uploads = [
      { ...upload("a.pdf", null), status: "complete" as const },
      { ...upload("b.png", null), status: "error" as const },
    ];
    expect(attachmentCount(["m1", "m2"], uploads)).toBe(3);
  });
});

describe("canAddMore", () => {
  it("is true below the limit and false at the limit", () => {
    expect(canAddMore(MAX_ATTACHMENT_COUNT - 1)).toBe(true);
    expect(canAddMore(MAX_ATTACHMENT_COUNT)).toBe(false);
  });
});

describe("filterDuplicateUploadFiles", () => {
  it("adds duplicate.pdf only once when picked twice in one batch", () => {
    const files = [
      new File(["a"], "duplicate.pdf"),
      new File(["b"], "duplicate.pdf"),
    ];
    expect(filterDuplicateUploadFiles(files, []).map((f) => f.name)).toEqual([
      "duplicate.pdf",
    ]);
  });

  it("allows report.pdf and report.xlsx when both are new", () => {
    const files = [
      new File(["a"], "report.pdf"),
      new File(["b"], "report.xlsx"),
    ];
    expect(filterDuplicateUploadFiles(files, []).map((f) => f.name)).toEqual([
      "report.pdf",
      "report.xlsx",
    ]);
  });

  it("skips a pick when the full filename already exists among uploads", () => {
    const files = [new File(["x"], "duplicate.pdf")];
    expect(
      filterDuplicateUploadFiles(files, ["duplicate.pdf"]).map((f) => f.name),
    ).toEqual([]);
  });

  it("skips a pick when the full filename matches a visible mail attachment", () => {
    const files = [new File(["x"], "RFQ.pdf")];
    expect(
      filterDuplicateUploadFiles(files, ["RFQ.pdf", "other.docx"]).map(
        (f) => f.name,
      ),
    ).toEqual([]);
  });
});

const ids = () => {
  let n = 0;
  return () => `u${n++}`;
};

describe("buildUploadedFiles", () => {
  it("flags unsupported types via uploadRejectionReason and mints ids", () => {
    const result = buildUploadedFiles([new File(["x"], "bad.exe")], ids(), 5);
    expect(result).toEqual([
      {
        id: "u0",
        file: expect.any(File),
        rejection: "unsupported type",
        selected: false,
      },
    ]);
    expect(result[0]).not.toHaveProperty("status");
  });

  it("auto-selects files up to the remaining slots and leaves overflow valid", () => {
    const files = [
      new File(["x"], "a.pdf"),
      new File(["x"], "b.pdf"),
      new File(["x"], "c.pdf"),
    ];
    const result = buildUploadedFiles(files, ids(), 1);
    expect(result.map((f) => f.rejection)).toEqual([null, null, null]);
    expect(result.map((f) => f.selected)).toEqual([true, false, false]);
    expect(result.map((f) => f.status)).toEqual(["pending", "pending", "pending"]);
    expect(result.map((f) => f.progress)).toEqual([0, 0, 0]);
  });
});
