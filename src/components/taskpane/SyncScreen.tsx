import { useEffect, useState } from "react";
import type { CSSProperties } from "react";
import { Check, TableProperties } from "lucide-react";

import { cn } from "@/lib/utils";

import { ConnectionRail } from "./SyncMotion";

interface SyncRequest {
  id: string;
  title: string;
  note: string;
}

const PROGRESS_TICK_MS = 180;

const PHASES = [
  { at: 0, label: "Reading Outlook context", detail: "Parsing the request card and selected coworker." },
  { at: 34, label: "Writing Base row", detail: "Mapping request fields into the Feishu Base schema." },
  { at: 68, label: "Backing up in Convex", detail: "Persisting a recoverable copy for workflow history." },
  { at: 90, label: "Final checks", detail: "Confirming the Base row and Convex backup." },
];

function phaseForProgress(progress: number) {
  for (let index = PHASES.length - 1; index >= 0; index -= 1) {
    if (progress >= PHASES[index].at) return PHASES[index];
  }
  return PHASES[0];
}

// Visual progress only — animates toward 98% and holds. The parent (RequestIntakeScreen)
// decides when the sync is actually done (the real action resolved) and flips the
// screen; this hook never auto-completes.
function useSyncProgress() {
  const [progress, setProgress] = useState(8);

  useEffect(() => {
    const progressTimer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= 98) return current;
        const step = current < 48 ? 8 : current < 82 ? 5 : 2;
        return Math.min(98, current + step);
      });
    }, PROGRESS_TICK_MS);

    return () => window.clearInterval(progressTimer);
  }, []);

  return progress;
}

function BaseRow({
  request,
  synced,
}: {
  request: SyncRequest;
  synced: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-10 items-center gap-2 rounded-lg px-2.5 text-xs shadow-edge transition-[background-color,box-shadow] duration-300",
        synced ? "bg-sage-soft text-sage" : "bg-background text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full transition-[background-color,color,scale] duration-300",
          synced
            ? "bg-sage text-background scale-100"
            : "bg-secondary text-muted-foreground scale-[0.92]",
        )}
      >
        {synced ? <Check className="size-3.5" /> : null}
      </span>
      <span className="min-w-0 flex-1 truncate">
        <strong>{request.title}</strong>
        <span className="font-normal"> / {request.note}</span>
      </span>
    </div>
  );
}

function BasePreview({
  requests,
  progress,
}: {
  requests: SyncRequest[];
  progress: number;
}) {
  const rows = requests.length > 0 ? requests.slice(0, 3) : [{ id: "empty", title: "Request", note: "Ready" }];

  return (
    <div className="mt-3 shrink-0 rounded-2xl bg-card-soft p-2 shadow-edge">
      <div className="rounded-lg bg-card px-3 py-2 shadow-edge">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase">
            <TableProperties className="size-3.5" />
            Base row preview
          </span>
          <span className="bg-accent text-accent-foreground rounded px-2 py-0.5 text-[10px] font-bold">
            Live
          </span>
        </div>
        <div className="mt-2 space-y-1.5">
          {rows.map((request, index) => {
            const synced = progress >= 34 + index * 22;
            return <BaseRow key={request.id} request={request} synced={synced} />;
          })}
        </div>
      </div>
    </div>
  );
}

function SyncHeader() {
  return (
    <header className="sync-enter w-full max-w-[420px] shrink-0 px-1 pb-3 text-center">
      <h1 className="text-[clamp(1.5rem,5vw,2.0625rem)] leading-[1.05] text-balance">
        Syncing to{" "}
        <br />
        Feishu Base&hellip;
      </h1>
    </header>
  );
}

function ProgressMeter({
  progress,
}: {
  progress: number;
}) {
  return (
    <div className="shrink-0 pt-1 pb-2 text-center">
      <div className="text-primary text-[clamp(2.25rem,10vw,3.375rem)] leading-[1.08] font-semibold tabular-nums tracking-tight">
        {progress}%
      </div>
      <progress className="sr-only" value={progress} max={100} aria-label="Sync progress" />
    </div>
  );
}

function PhaseStatus({
  phase,
}: {
  phase: (typeof PHASES)[number];
}) {
  return (
    <div className="mt-2 shrink-0 text-center">
      <h2 className="text-muted-foreground text-sm font-normal italic text-balance">
        {phase.label}
      </h2>
      <p className="text-muted-foreground/70 mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed font-light text-pretty">
        {phase.detail}
      </p>
    </div>
  );
}

function SyncPanel({
  requests,
  progress,
}: {
  requests: SyncRequest[];
  progress: number;
}) {
  const phase = phaseForProgress(progress);

  return (
    <section
      aria-label="Feishu Base sync progress"
      className="sync-enter bg-card flex w-full max-w-[420px] flex-none flex-col justify-start overflow-hidden rounded-2xl p-4 shadow-float sm:p-5"
      style={
        {
          "--enter-delay": "70ms",
        } as CSSProperties
      }
    >
      <ProgressMeter progress={progress} />
      <ConnectionRail />
      <PhaseStatus phase={phase} />
      <BasePreview requests={requests} progress={progress} />
    </section>
  );
}

export function SyncScreen({ requests }: { requests: SyncRequest[] }) {
  const progress = useSyncProgress();

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 overflow-y-auto px-5">
      <div className="flex min-h-full w-full flex-col items-center justify-center py-6">
        <SyncHeader />
        <SyncPanel requests={requests} progress={progress} />
      </div>
    </div>
  );
}
