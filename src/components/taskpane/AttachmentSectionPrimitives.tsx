import { FileSpreadsheet, FileText, Image as ImageIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

import { fileExtension } from "../../office/attachments";

export const META_CLASS = "shrink-0 text-[11px] text-muted-foreground tabular-nums";
export const ROW_PRESS =
  "transition-transform duration-150 ease-[var(--ease-out-strong)] active:scale-[0.96]";

const ROW_GRID =
  "grid min-h-12 min-w-0 grid-cols-[2.5rem_1.25rem_minmax(0,1fr)_auto] items-center gap-x-2 px-2 py-2";
const GROUP_TITLE_CLASS =
  "text-muted-foreground flex min-h-7 items-center justify-between px-2 text-[10px] leading-none font-semibold tracking-wide uppercase";
const SPREADSHEET_EXT = new Set(["xls", "xlsx", "csv"]);
const IMAGE_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp"]);

export type StatusTone = "blocked" | "muted";

export function isImageAttachment(name: string) {
  return IMAGE_EXT.has(fileExtension(name));
}

export function isSpreadsheetAttachment(name: string) {
  return SPREADSHEET_EXT.has(fileExtension(name));
}

export function FileGlyph({ name }: { name: string }) {
  const Icon = isSpreadsheetAttachment(name) ? FileSpreadsheet : isImageAttachment(name) ? ImageIcon : FileText;
  return <Icon className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />;
}

export function StatusBadge({ tone, children }: { tone: StatusTone; children: ReactNode }) {
  if (tone === "blocked") {
    return (
      <span className="bg-destructive/10 text-destructive inline-flex h-6 shrink-0 items-center rounded-full px-2 text-[10px] font-semibold tracking-wide uppercase">
        {children}
      </span>
    );
  }

  return (
    <Badge
      variant="outline"
      className={cn("h-6 border-transparent px-2 tabular-nums", tone === "muted" && "opacity-70")}
    >
      {children}
    </Badge>
  );
}

interface AttachmentRowProps {
  lead?: ReactNode;
  icon: ReactNode;
  title: ReactNode;
  subtitle?: ReactNode;
  status?: ReactNode;
}

export function AttachmentRow({
  lead,
  icon,
  title,
  subtitle,
  status,
}: AttachmentRowProps) {
  return (
    <div className="rounded-xl transition-[background-color,box-shadow] duration-150 ease-[var(--ease-out-strong)]">
      <div className={ROW_GRID}>
        <div className="flex size-10 shrink-0 items-center justify-center">{lead}</div>
        <div className="flex size-5 shrink-0 items-center justify-center [&_svg]:translate-y-px">{icon}</div>
        <div className="min-w-0">
          <div className="truncate text-xs leading-5 font-semibold">{title}</div>
          {subtitle ? (
            <div className="text-muted-foreground mt-0.5 truncate text-[11px] leading-4">{subtitle}</div>
          ) : null}
        </div>
        <div className="justify-self-end">{status}</div>
      </div>
    </div>
  );
}

function GroupHeading({ title, count }: { title: string; count?: number | string }) {
  return (
    <div className={GROUP_TITLE_CLASS}>
      <span>{title}</span>
      {count === undefined ? null : <span className="tabular-nums">{count}</span>}
    </div>
  );
}

export function AttachmentGroup({
  title,
  count,
  children,
}: {
  title: string;
  count?: number | string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <GroupHeading title={title} count={count} />
      <div className="space-y-1">{children}</div>
    </div>
  );
}
