import type { ReactNode } from "react";

import { Mail, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type AttachmentSourceKind = "outlook" | "uploaded";

const SOURCE_META: Record<
  AttachmentSourceKind,
  { label: string; Icon: typeof Mail; shell: string }
> = {
  outlook: {
    label: "Outlook",
    Icon: Mail,
    shell: "bg-primary/10 text-primary",
  },
  uploaded: {
    label: "Uploaded",
    Icon: Upload,
    shell: "bg-muted/60 text-muted-foreground",
  },
};

function SourceTitle({
  source,
  count,
}: {
  source: AttachmentSourceKind;
  count: number;
}) {
  const { label, Icon, shell } = SOURCE_META[source];
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-md",
          shell,
        )}
        aria-hidden="true"
      >
        <Icon className="size-3.5" strokeWidth={2} />
      </span>
      <span className="text-muted-foreground text-xs font-semibold tracking-wide uppercase">
        {label}
      </span>
      <Badge
        variant="secondary"
        className="h-4 min-h-[14px] rounded-full px-1.5 py-0 text-[9px] tabular-nums"
      >
        {count}
      </Badge>
    </div>
  );
}

function HeaderAction({
  children,
  onSelectAll,
}: {
  children: ReactNode;
  onSelectAll?: () => void;
}) {
  if (!onSelectAll) return null;
  return (
    <button
      type="button"
      className="text-muted-foreground hover:text-foreground shrink-0 text-[11px] font-semibold outline-none transition-colors duration-150 ease-[var(--ease-out-strong)] focus-visible:ring-[3px] focus-visible:ring-ring/20"
      onClick={onSelectAll}
    >
      {children}
    </button>
  );
}

export function SourceHeader({
  source,
  count,
  onSelectAll,
  selectAllLabel = "Select all",
}: {
  source: AttachmentSourceKind;
  count: number;
  onSelectAll?: () => void;
  selectAllLabel?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-2 px-4 pt-4 pb-2">
      <SourceTitle source={source} count={count} />
      <HeaderAction onSelectAll={onSelectAll}>{selectAllLabel}</HeaderAction>
    </div>
  );
}

export function SourceGroupSeparator() {
  return <div className="border-t border-border" role="presentation" />;
}
