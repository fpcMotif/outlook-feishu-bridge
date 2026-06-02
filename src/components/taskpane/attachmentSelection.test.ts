import { describe, expect, it } from "vitest";

import {
  attachmentCount,
  buildUploadedFiles,
  canAddMore,
} from "./attachmentSelection";
import { MAX_ATTACHMENT_COUNT } from "../../office/attachments";
import type { UploadedFile } from "./intakeReducer";

const upload = (name: string, rejection: string | null): UploadedFile => ({
  id: name,
  file: new File(["x"], name),
  rejection,
});

describe("attachmentCount", () => {
  it("counts checked mail ids plus valid uploads, excluding rejected uploads", () => {
    const uploads = [upload("a.pdf", null), upload("b.png", null), upload("c.exe", "unsupported type")];
    expect(attachmentCount(["m1", "m2"], uploads)).toBe(4);
  });
});

describe("canAddMore", () => {
  it("is true below the limit and false at the limit", () => {
    expect(canAddMore(MAX_ATTACHMENT_COUNT - 1)).toBe(true);
    expect(canAddMore(MAX_ATTACHMENT_COUNT)).toBe(false);
  });
});

describe("buildUploadedFiles", () => {
  const ids = () => {
    let n = 0;
    return () => `u${n++}`;
  };

  it("flags unsupported types via uploadRejectionReason and mints ids", () => {
    const result = buildUploadedFiles([new File(["x"], "bad.exe")], ids(), 5);
    expect(result).toEqual([{ id: "u0", file: expect.any(File), rejection: "unsupported type" }]);
  });

  it("accepts files up to the remaining slots and rejects the overflow", () => {
    const files = [new File(["x"], "a.pdf"), new File(["x"], "b.pdf"), new File(["x"], "c.pdf")];
    const result = buildUploadedFiles(files, ids(), 1);
    expect(result.map((f) => f.rejection)).toEqual([
      null,
      `exceeds the ${MAX_ATTACHMENT_COUNT}-file limit`,
      `exceeds the ${MAX_ATTACHMENT_COUNT}-file limit`,
    ]);
  });
});
