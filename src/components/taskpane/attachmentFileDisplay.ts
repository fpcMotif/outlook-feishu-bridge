import type { ComponentType, SVGProps } from "react";

import { fileExtension } from "../../office/attachments";
import { ArchiveFileIcon } from "./icons/ArchiveFileIcon";
import { GenericFileIcon } from "./icons/GenericFileIcon";
import { ImageFileIcon } from "./icons/ImageFileIcon";
import { PdfFileIcon } from "./icons/PdfFileIcon";
import { SpreadsheetFileIcon } from "./icons/SpreadsheetFileIcon";
import { TextFileIcon } from "./icons/TextFileIcon";

export function extOf(name: string): string {
  return fileExtension(name);
}

export function nameWithoutExt(name: string): string {
  const ext = extOf(name);
  if (!ext) return name;
  return name.slice(0, -(ext.length + 1));
}

export type FileIconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number };

export type AttachmentFileIcon = {
  Icon: ComponentType<FileIconProps>;
  tint: string;
  bg: string;
  border: string;
  accent: string;
};

type AttachmentFileIconStyle = Omit<AttachmentFileIcon, "Icon">;

const ICON_STYLES = {
  image: {
    tint: "text-primary",
    bg: "bg-primary/10",
    border: "border-primary/20",
    accent: "bg-primary",
  },
  spreadsheet: {
    tint: "text-sage",
    bg: "bg-sage-soft",
    border: "border-sage/20",
    accent: "bg-sage",
  },
  archive: {
    tint: "text-file-amber",
    bg: "bg-file-amber-soft",
    border: "border-file-amber/20",
    accent: "bg-file-amber",
  },
  pdf: {
    tint: "text-file-rose",
    bg: "bg-file-rose-soft",
    border: "border-file-rose/20",
    accent: "bg-file-rose",
  },
  text: {
    tint: "text-file-rose",
    bg: "bg-file-rose-soft",
    border: "border-file-rose/20",
    accent: "bg-file-rose",
  },
  unknown: {
    tint: "text-muted-foreground",
    bg: "bg-muted/40",
    border: "border-border",
    accent: "bg-muted-foreground/40",
  },
} satisfies Record<string, AttachmentFileIconStyle>;

export function iconFor(name: string): AttachmentFileIcon {
  const ext = extOf(name);

  if (["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"].includes(ext)) {
    return { Icon: ImageFileIcon, ...ICON_STYLES.image };
  }
  if (["xls", "xlsx", "csv"].includes(ext)) {
    return { Icon: SpreadsheetFileIcon, ...ICON_STYLES.spreadsheet };
  }
  if (["zip", "rar", "7z"].includes(ext)) {
    return { Icon: ArchiveFileIcon, ...ICON_STYLES.archive };
  }
  if (ext === "pdf") {
    return { Icon: PdfFileIcon, ...ICON_STYLES.pdf };
  }
  if (["doc", "docx", "txt"].includes(ext)) {
    return { Icon: TextFileIcon, ...ICON_STYLES.text };
  }
  return { Icon: GenericFileIcon, ...ICON_STYLES.unknown };
}
