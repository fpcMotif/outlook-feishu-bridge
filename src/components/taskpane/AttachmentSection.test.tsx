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

const upload = (
  id: string,
  name: string,
  rejection: string | null = null,
): UploadedFile => ({
  id,
  file: new File(["x"], name),
  rejection,
  selected: rejection === null,
});

function setup(
  props: {
    mailAttachments?: AttachmentInfo[];
    selectedIds?: string[];
    uploadedFiles?: UploadedFile[];
    onRetryUpload?: (id: string) => void;
  } = {},
) {
  const onRetryUpload = props.onRetryUpload;
  const handlers = {
    onToggleMail: vi.fn(),
    onRemoveMail: vi.fn(),
    onToggleUpload: vi.fn(),
    onSetUploadedSelection: vi.fn(),
    onAddFiles: vi.fn(),
    onRemoveUpload: vi.fn(),
    ...(onRetryUpload ? { onRetryUpload } : {}),
  };
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
  it("groups attachment sources without preview controls", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf", 180 * 1024)],
      uploadedFiles: [upload("u1", "sample.docx")],
    });

    expect(screen.getByText("Outlook")).toBeInTheDocument();
    expect(screen.queryByText(/From Outlook/i)).not.toBeInTheDocument();
    expect(screen.getByText("Uploaded")).toBeInTheDocument();
    expect(screen.queryByText(/Local upload/i)).not.toBeInTheDocument();
    expect(screen.getByText("180.0 KB")).toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("docx")).toBeInTheDocument();
    expect(
      screen.getByText("Drag & drop files or click to upload"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/pdf.*xls.*doc.*image/i)).not.toBeInTheDocument();
    expect(screen.queryByText("Ready")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /preview/i }),
    ).not.toBeInTheDocument();
  });

  it("shows upload progress on an uploading file row", () => {
    setup({
      uploadedFiles: [
        {
          ...upload("u1", "quote.xlsx"),
          status: "uploading",
          progress: 37,
        },
      ],
    });

    expect(
      screen.getByRole("progressbar", { name: /upload progress/i }),
    ).toHaveAttribute("aria-valuenow", "37");
    expect(screen.queryByText("37%")).not.toBeInTheDocument();
  });

  it("shows retry on a failed upload row", () => {
    const onRetryUpload = vi.fn();
    setup({
      uploadedFiles: [
        {
          ...upload("u1", "quote.xlsx"),
          status: "error",
          uploadError: "network",
        },
      ],
      onRetryUpload,
    });

    fireEvent.click(screen.getByRole("button", { name: /^Retry$/i }));
    expect(onRetryUpload).toHaveBeenCalledWith("u1");
  });

  it("pins retry and remove together on a failed upload, folding failure into the subtitle (no hover swap)", () => {
    setup({
      uploadedFiles: [
        {
          ...upload("u1", "quote.xlsx"),
          status: "error",
          uploadError: "Convex storage upload failed (network)",
        },
      ],
      onRetryUpload: vi.fn(),
    });

    // FAILED is no longer a trailing badge — failure shows on the icon + as a
    // humanized, destructive subtitle, freeing the row width for the filename.
    expect(screen.queryByText("Failed")).not.toBeInTheDocument();
    expect(
      screen.getByText("Couldn't upload — check your connection, then Retry"),
    ).toBeInTheDocument();

    // Retry stays put — its wrapper must NOT carry the hover-hide class.
    const retry = screen.getByRole("button", { name: /^Retry$/i });
    expect(retry.parentElement?.className).not.toContain(
      "group-hover/attachment:opacity-0",
    );

    // Trash is always visible (not gated behind hover) so Retry + trash coexist.
    const removeButton = screen.getByRole("button", {
      name: /remove quote\.xlsx/i,
    });
    expect(removeButton.parentElement?.className).toContain("opacity-100");
    expect(removeButton.parentElement?.className).not.toContain(
      "group-hover/attachment:opacity-100",
    );
  });

  it("uses only the checkbox for selected attachment state", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
      uploadedFiles: [upload("u1", "quote.xlsx")],
    });

    expect(screen.queryByText("2 ready")).not.toBeInTheDocument();
    expect(screen.queryByText("Selected")).not.toBeInTheDocument();
    expect(
      screen.getByRole("checkbox", { name: /RFQ-2026-Q1\.pdf/i }),
    ).toHaveAttribute("aria-checked", "true");
  });

  it("hides upload progress once a file row is complete", () => {
    setup({
      uploadedFiles: [{ ...upload("u1", "quote.xlsx"), status: "complete" }],
    });

    expect(
      screen.queryByRole("progressbar", { name: /upload progress/i }),
    ).not.toBeInTheDocument();
  });

  it("shows size-only metadata without a date on mail rows", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf", 180 * 1024)],
      selectedIds: [],
    });
    const meta = screen.getByText("180.0 KB");
    expect(meta.textContent).toBe("180.0 KB");
    expect(meta.textContent).not.toMatch(/•|may|jun|\d{1,2}\/\d/i);
  });

  it("renders attachment count metadata in the header", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
      uploadedFiles: [upload("u1", "quote.xlsx")],
    });

    expect(screen.queryByText(/selected/i)).not.toBeInTheDocument();
    expect(screen.getByText(/2\/10/)).toBeInTheDocument();
    expect(screen.getByText(/total/)).toBeInTheDocument();
  });

  it("sums only selected mail attachments in the header total", () => {
    const selectedSize = 50 * 1024;
    const unselectedSize = 100 * 1024;
    setup({
      mailAttachments: [
        mail("a1", "selected.pdf", selectedSize),
        mail("a2", "unselected.pdf", unselectedSize),
        mail("a3", "also-unselected.pdf", unselectedSize),
      ],
      selectedIds: ["a1"],
      uploadedFiles: [],
    });

    expect(screen.getByText(/50\.0 KB total/)).toBeInTheDocument();
    expect(screen.queryByText(/205\.1 KB total/)).not.toBeInTheDocument();
    expect(screen.getByText(/1\/10/)).toBeInTheDocument();
  });

  it("shows zero total when no mail attachments are selected", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf", 180 * 1024)],
      selectedIds: [],
      uploadedFiles: [],
    });

    expect(screen.getByText(/0 B total/)).toBeInTheDocument();
    expect(screen.getByText(/0\/10/)).toBeInTheDocument();
  });

  it("shows a remove control on uploaded rows", () => {
    setup({ uploadedFiles: [upload("u1", "quote.xlsx")] });
    expect(
      screen.getByRole("button", { name: /remove quote\.xlsx/i }),
    ).toBeInTheDocument();
  });

  it("uses destructive color for row remove controls", () => {
    setup({ uploadedFiles: [upload("u1", "quote.xlsx")] });
    const removeButton = screen.getByRole("button", {
      name: /remove quote\.xlsx/i,
    });
    expect(removeButton).toHaveClass("text-destructive");
    expect(removeButton.className).toContain("hover:bg-muted");
  });

  it("uses the same base-name plus extension-badge display for every source", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      uploadedFiles: [upload("u1", "Untitled spreadsheet.xlsx")],
    });
    expect(screen.getByText("RFQ-2026-Q1")).toBeInTheDocument();
    expect(screen.queryByText("RFQ-2026-Q1.pdf")).not.toBeInTheDocument();
    expect(screen.getByText("Untitled spreadsheet")).toBeInTheDocument();
    expect(
      screen.queryByText("Untitled spreadsheet.xlsx"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("pdf")).toBeInTheDocument();
    expect(screen.getByText("xlsx")).toBeInTheDocument();
  });

  it("deselects all uploaded files from the uploaded header action", () => {
    const { onSetUploadedSelection } = setup({
      uploadedFiles: [upload("u1", "quote.xlsx"), upload("u2", "photo.png")],
    });

    fireEvent.click(screen.getByRole("button", { name: /deselect all/i }));

    expect(onSetUploadedSelection).toHaveBeenCalledWith([]);
  });

  it("selects all uploaded files from the uploaded header action", () => {
    const unselected = { ...upload("u1", "quote.xlsx"), selected: false };
    const { onSetUploadedSelection } = setup({ uploadedFiles: [unselected] });

    fireEvent.click(screen.getByRole("button", { name: /select all/i }));

    expect(onSetUploadedSelection).toHaveBeenCalledWith(["u1"]);
  });

  it("shows a remove control on selected mail rows", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
    });
    expect(
      screen.getByRole("button", { name: /remove RFQ-2026-Q1\.pdf/i }),
    ).toBeInTheDocument();
  });

  it("shows remove on unselected mail rows with row-hover classes", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: [],
    });
    const removeButton = screen.getByRole("button", {
      name: /remove RFQ-2026-Q1\.pdf/i,
    });
    expect(removeButton.parentElement?.className).toContain(
      "group-hover/attachment:opacity-100",
    );
  });

  it("forwards unselected mail remove to onRemoveMail", () => {
    const { onRemoveMail, onToggleMail } = setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: [],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /remove RFQ-2026-Q1\.pdf/i }),
    );
    expect(onRemoveMail).toHaveBeenCalledWith("a1");
    expect(onToggleMail).not.toHaveBeenCalled();
  });

  it("forwards selected mail remove to onRemoveMail", () => {
    const { onRemoveMail, onToggleMail } = setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /remove RFQ-2026-Q1\.pdf/i }),
    );
    expect(onRemoveMail).toHaveBeenCalledWith("a1");
    expect(onToggleMail).not.toHaveBeenCalled();
  });

  it("applies fine-pointer row-hover classes to selected mail remove", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
    });
    const removeButton = screen.getByRole("button", {
      name: /remove RFQ-2026-Q1\.pdf/i,
    });
    expect(removeButton.parentElement?.className).toContain(
      "group-hover/attachment:opacity-100",
    );
  });

  it("toggles a mail attachment via its checkbox", () => {
    const { onToggleMail } = setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
    });
    fireEvent.click(
      screen.getByRole("checkbox", { name: /RFQ-2026-Q1\.pdf/i }),
    );
    expect(onToggleMail).toHaveBeenCalledWith("a1");
  });

  it("forwards picked files to onAddFiles", () => {
    const { onAddFiles } = setup();
    const file = new File(["x"], "spec.pdf");
    fireEvent.change(screen.getByTestId("attachment-upload-input"), {
      target: { files: [file] },
    });
    expect(onAddFiles).toHaveBeenCalledTimes(1);
    expect(onAddFiles.mock.calls[0][0][0]).toBe(file);
  });

  it("toggles an uploaded file via its checkbox", () => {
    const { onToggleUpload } = setup({
      uploadedFiles: [upload("u1", "quote.xlsx")],
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /quote\.xlsx/i }));
    expect(onToggleUpload).toHaveBeenCalledWith("u1");
  });

  it("removes an uploaded file via the row remove control", () => {
    const { onRemoveUpload } = setup({
      uploadedFiles: [upload("u1", "quote.xlsx")],
    });
    fireEvent.click(
      screen.getByRole("button", { name: /remove quote\.xlsx/i }),
    );
    expect(onRemoveUpload).toHaveBeenCalledWith("u1");
  });

  it("shows a rejection reason while keeping removal separate from selection", () => {
    const { onRemoveUpload } = setup({
      uploadedFiles: [upload("u1", "bad.exe", "unsupported type")],
    });
    expect(screen.getByText("unsupported type")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: /bad\.exe/i })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: /remove bad\.exe/i }));
    expect(onRemoveUpload).toHaveBeenCalledWith("u1");
  });

  it("keeps upload available while disabling unchecked rows at the selection limit", () => {
    const selectedIds = Array.from({ length: 10 }, (_, i) => `m${i}`);
    setup({ mailAttachments: [mail("extra", "extra.pdf")], selectedIds });
    expect(screen.queryByText(/^\d+ selected$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/10\/10/)).toBeInTheDocument();
    expect(screen.getByTestId("attachment-upload-input")).not.toBeDisabled();
    expect(
      screen.getByRole("checkbox", { name: /extra\.pdf/i }),
    ).toBeDisabled();
  });

  it("does not render a header bulk-remove action", () => {
    setup({
      mailAttachments: [mail("a1", "RFQ-2026-Q1.pdf")],
      selectedIds: ["a1"],
      uploadedFiles: [upload("u1", "quote.xlsx")],
    });

    expect(
      screen.queryByRole("button", { name: /remove \d+ selected attachment/i }),
    ).not.toBeInTheDocument();
  });

  it("selects all outlook attachments when Select all is used", () => {
    const { onToggleMail } = setup({
      mailAttachments: [mail("a1", "one.pdf"), mail("a2", "two.pdf")],
      selectedIds: [],
    });
    fireEvent.click(screen.getByRole("button", { name: /select all/i }));
    expect(onToggleMail).toHaveBeenCalledWith("a1");
    expect(onToggleMail).toHaveBeenCalledWith("a2");
  });

  it("highlights selected mail rows", () => {
    const { container } = render(
      <AttachmentSection
        mailAttachments={[mail("a1", "RFQ-2026-Q1.pdf")]}
        selectedIds={["a1"]}
        uploadedFiles={[]}
        onToggleMail={vi.fn()}
        onRemoveMail={vi.fn()}
        onToggleUpload={vi.fn()}
        onSetUploadedSelection={vi.fn()}
        onAddFiles={vi.fn()}
        onRemoveUpload={vi.fn()}
      />,
    );
    const selectedRow = container.querySelector(".bg-primary\\/5");
    expect(selectedRow).toBeTruthy();
  });
});
