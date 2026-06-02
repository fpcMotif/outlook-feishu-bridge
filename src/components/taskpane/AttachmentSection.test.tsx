/* eslint-disable max-lines-per-function */
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AttachmentSection } from "./AttachmentSection";
import type { AttachmentInfo } from "../../office/mailItem";
import type { UploadedFile } from "./intakeReducer";

const mail = (id: string, name: string, size = 1024): AttachmentInfo => ({
  id,
  name,
  attachmentType: "file",
  size,
  isInline: false,
});

const upload = (id: string, name: string, rejection: string | null = null): UploadedFile => ({
  id,
  file: new File(["x"], name),
  rejection,
});

function setup(
  props: {
    mailAttachments?: AttachmentInfo[];
    selectedIds?: string[];
    uploadedFiles?: UploadedFile[];
  } = {},
) {
  const handlers = { onToggleMail: vi.fn(), onAddFiles: vi.fn(), onRemoveUpload: vi.fn() };
  render(
    <AttachmentSection
      mailAttachments={props.mailAttachments ?? []}
      selectedIds={props.selectedIds ?? []}
      uploadedFiles={props.uploadedFiles ?? []}
      {...handlers}
    />,
  );
  return handlers;
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("AttachmentSection", () => {
  it("toggles a mail attachment via its checkbox", () => {
    const { onToggleMail } = setup({ mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")] });
    fireEvent.click(screen.getByRole("checkbox", { name: /RFQ-2026-Q1\.pdf/i }));
    expect(onToggleMail).toHaveBeenCalledWith("a1");
  });

  it("forwards picked files to onAddFiles", () => {
    const { onAddFiles } = setup();
    const file = new File(["x"], "spec.pdf");
    fireEvent.change(screen.getByTestId("attachment-upload-input"), { target: { files: [file] } });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0][0][0]).toBe(file);
  });

  it("shows a rejection reason and removes an uploaded file", () => {
    const { onRemoveUpload } = setup({ uploadedFiles: [upload("u1", "bad.exe", "unsupported type")] });
    expect(screen.getByText("unsupported type")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /remove bad\.exe/i }));
    expect(onRemoveUpload).toHaveBeenCalledWith("u1");
  });

  it("renders the count and disables adding + unchecked rows at the limit", () => {
    const selectedIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    setup({ mailAttachments: [mail("extra", "extra.pdf")], selectedIds });
    expect(screen.getByText("10 / 10")).toBeInTheDocument();
    expect(screen.getByTestId("attachment-upload-input")).toBeDisabled();
    expect(screen.getByRole("checkbox", { name: /extra\.pdf/i })).toBeDisabled();
  });
});
