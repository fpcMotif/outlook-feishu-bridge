import { describe, expect, it } from "vitest";

import { ArchiveFileIcon } from "./icons/ArchiveFileIcon";
import { GenericFileIcon } from "./icons/GenericFileIcon";
import { ImageFileIcon } from "./icons/ImageFileIcon";
import { PdfFileIcon } from "./icons/PdfFileIcon";
import { SpreadsheetFileIcon } from "./icons/SpreadsheetFileIcon";
import { TextFileIcon } from "./icons/TextFileIcon";
import { extOf, iconFor, nameWithoutExt } from "./attachmentFileDisplay";

describe("attachmentFileDisplay", () => {
  it("extracts extension via extOf", () => {
    expect(extOf("RFQ-2026-Q1.PDF")).toBe("pdf");
    expect(extOf("noext")).toBe("");
  });

  it("removes only the trailing extension for display names", () => {
    expect(nameWithoutExt("Untitled spreadsheet.xlsx")).toBe("Untitled spreadsheet");
    expect(nameWithoutExt("feishu.import.export.xlsx")).toBe("feishu.import.export");
    expect(nameWithoutExt("noext")).toBe("noext");
  });

  it("maps file types to custom icons and tint shells", () => {
    expect(iconFor("photo.png")).toMatchObject({
      Icon: ImageFileIcon,
      tint: "text-primary",
      bg: "bg-primary/10",
      border: "border-primary/20",
      accent: "bg-primary",
    });
    expect(iconFor("quote.xlsx")).toMatchObject({
      Icon: SpreadsheetFileIcon,
      tint: "text-sage",
      bg: "bg-sage-soft",
      border: "border-sage/20",
      accent: "bg-sage",
    });
    expect(iconFor("bundle.zip")).toMatchObject({
      Icon: ArchiveFileIcon,
      tint: "text-file-amber",
      bg: "bg-file-amber-soft",
      border: "border-file-amber/20",
      accent: "bg-file-amber",
    });
    expect(iconFor("RFQ.pdf")).toMatchObject({
      Icon: PdfFileIcon,
      tint: "text-file-rose",
      bg: "bg-file-rose-soft",
      border: "border-file-rose/20",
      accent: "bg-file-rose",
    });
    expect(iconFor("notes.txt")).toMatchObject({
      Icon: TextFileIcon,
      tint: "text-file-rose",
      bg: "bg-file-rose-soft",
      border: "border-file-rose/20",
      accent: "bg-file-rose",
    });
    expect(iconFor("unknown.bin")).toMatchObject({
      Icon: GenericFileIcon,
      tint: "text-muted-foreground",
      bg: "bg-muted/40",
      border: "border-border",
      accent: "bg-muted-foreground/40",
    });
  });
});
