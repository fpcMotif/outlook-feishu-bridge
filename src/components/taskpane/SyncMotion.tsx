import type { ReactNode } from "react";
import { Database, FileText, Mail, TableProperties } from "lucide-react";

import { cn } from "@/lib/utils";

export interface SyncMotionRequest {
  title: string;
  note: string;
}

function StatusOrb({
  icon,
  label,
  active,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <div
        className={cn(
          "relative flex size-14 items-center justify-center rounded-full shadow-[var(--shadow-border)]",
          active ? "bg-accent text-primary" : "bg-card-soft text-muted-foreground",
        )}
      >
        {active ? <span className="sync-orb-pulse absolute inset-0 rounded-full" /> : null}
        <span className="relative z-10">{icon}</span>
      </div>
      <span className="text-muted-foreground text-[11px] font-semibold">{label}</span>
    </div>
  );
}

function DataPacket({ request }: { request: SyncMotionRequest | undefined }) {
  return (
    <div className="sync-packet-shell absolute top-1/2 z-10">
      <div className="sync-packet-card bg-card text-card-foreground flex max-w-[188px] items-center gap-2 rounded-full px-3 py-2 shadow-[var(--shadow-floating)]">
        <FileText className="text-primary size-4 shrink-0" />
        <span className="min-w-0 truncate text-xs">
          <strong>{request?.title ?? "Request"}:</strong> {request?.note ?? "Sync packet"}
        </span>
      </div>
    </div>
  );
}

export function ConnectionRail({
  progress,
  request,
}: {
  progress: number;
  request: SyncMotionRequest | undefined;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <StatusOrb icon={<Mail className="size-6" />} label="Outlook" />
      <div className="relative h-14 min-w-0 flex-1">
        <div className="absolute top-1/2 inset-x-0 h-px -translate-y-1/2 bg-border" />
        <div
          className="absolute top-1/2 left-0 h-[2px] w-full origin-left -translate-y-1/2 rounded-full bg-primary transition-transform duration-300 ease-[var(--ease-out-strong)]"
          style={{ transform: `translateY(-50%) scaleX(${progress / 100})` }}
        />
        <DataPacket request={request} />
      </div>
      <StatusOrb icon={<Database className="size-6" />} label="Bitable" active />
    </div>
  );
}

export function SyncFoldPreview({ request }: { request: SyncMotionRequest | undefined }) {
  return (
    <div className="sync-fold-stage relative mt-5 h-[76px] overflow-hidden rounded-xl bg-card-soft shadow-[var(--shadow-border)]">
      <div className="absolute inset-y-0 left-5 flex items-center">
        <div className="sync-fold-card grid h-[46px] w-[118px] grid-cols-3 overflow-hidden rounded-lg bg-card text-[10px] shadow-[var(--shadow-floating)]">
          <div className="sync-fold-panel sync-fold-panel-left border-r p-2">
            <div className="bg-primary/70 h-1.5 w-6 rounded-full" />
            <div className="bg-muted mt-2 h-1.5 w-8 rounded-full" />
          </div>
          <div className="sync-fold-panel p-2">
            <div className="text-[9px] font-bold uppercase tracking-wide text-primary">
              {request?.title ?? "Request"}
            </div>
            <div className="bg-muted mt-2 h-1.5 w-8 rounded-full" />
          </div>
          <div className="sync-fold-panel sync-fold-panel-right border-l p-2">
            <div className="bg-muted h-1.5 w-6 rounded-full" />
            <div className="bg-muted mt-2 h-1.5 w-8 rounded-full" />
          </div>
        </div>
      </div>
      <div className="absolute inset-y-0 right-5 flex items-center">
        <div className="bg-primary text-primary-foreground flex size-11 items-center justify-center rounded-xl shadow-[var(--shadow-border)]">
          <TableProperties className="size-5" />
        </div>
      </div>
    </div>
  );
}
