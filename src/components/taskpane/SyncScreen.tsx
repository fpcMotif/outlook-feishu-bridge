import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";
import { ArrowRight, Check, ShieldCheck, TableProperties } from "lucide-react";

import { cn } from "@/lib/utils";

import { ConnectionRail, SyncFoldPreview } from "./SyncMotion";

interface SyncRequest {
  id: string;
  title: string;
  note: string;
}

const SYNC_DURATION_MS = 3600;
const PROGRESS_TICK_MS = 180;
const PACKET_MIN_PROGRESS = 12;
const PACKET_MAX_PROGRESS = 88;

const PHASES = [
  { at: 0, label: "Reading Outlook context", detail: "Parsing the request card and selected coworker." },
  { at: 34, label: "Writing Bitable row", detail: "Mapping request fields into the Feishu table schema." },
  { at: 68, label: "Backing up in Convex", detail: "Persisting a recoverable copy for workflow history." },
  { at: 90, label: "Final checks", detail: "Confirming the Bitable row and Convex backup." },
];

function phaseForProgress(progress: number) {
  for (let index = PHASES.length - 1; index >= 0; index -= 1) {
    if (progress >= PHASES[index].at) return PHASES[index];
  }
  return PHASES[0];
}

// Visual progress only — animates toward 98% and holds. The parent (ForwardScreen)
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

function BitableRow({
  request,
  synced,
}: {
  request: SyncRequest;
  synced: boolean;
}) {
  return (
    <div
      className={cn(
        "flex h-11 items-center gap-2 rounded-lg px-2.5 text-xs shadow-[var(--shadow-border)] transition-[background-color,box-shadow] duration-300",
        synced ? "bg-accent text-accent-foreground" : "bg-background text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center rounded-full transition-[background-color,color,scale] duration-300",
          synced
            ? "bg-primary text-primary-foreground scale-100"
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

function BitablePreview({
  requests,
  progress,
}: {
  requests: SyncRequest[];
  progress: number;
}) {
  const rows = requests.length > 0 ? requests.slice(0, 3) : [{ id: "empty", title: "Request", note: "Ready" }];

  return (
    <div className="mt-5 rounded-2xl bg-card-soft p-2 shadow-[var(--shadow-border)]">
      <div className="rounded-xl bg-card px-3 py-2 shadow-[var(--shadow-border)]">
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[11px] font-semibold uppercase">
            <TableProperties className="size-3.5" />
            Bitable row preview
          </span>
          <span className="bg-accent text-accent-foreground rounded px-2 py-0.5 text-[10px] font-bold">
            Live
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {rows.map((request, index) => {
            const synced = progress >= 34 + index * 22;
            return <BitableRow key={request.id} request={request} synced={synced} />;
          })}
        </div>
      </div>
    </div>
  );
}

function SyncHeader() {
  return (
    <header className="sync-enter w-full max-w-[520px] px-1 pb-5">
      <div className="text-accent-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
        <span className="bg-muted-foreground inline-block h-px w-3.5" />
        Act IV
      </div>
      <h1 className="font-serif text-[33px] leading-[1.02] text-balance">
        Syncing to{" "}
        <br />
        Feishu Bitable&hellip;
      </h1>
      <p className="text-foreground/70 mt-2 max-w-[34ch] text-sm leading-relaxed text-pretty">
        Folding the email context into a structured Bitable record with a Convex backup.
      </p>
    </header>
  );
}

function ProgressMeter({
  progress,
  phase,
}: {
  progress: number;
  phase: (typeof PHASES)[number];
}) {
  return (
    <div className="mt-6 text-center">
      <div className="text-primary font-serif text-[54px] leading-none font-semibold tabular-nums">
        {progress}%
      </div>
      <progress className="sr-only" value={progress} max={100} aria-label="Sync progress" />
      <div aria-hidden="true" className="bg-secondary mt-4 h-2 overflow-hidden rounded-full">
        <div
          className="bg-primary h-full w-full origin-left rounded-full transition-transform duration-300 ease-[var(--ease-out-strong)]"
          style={{ transform: `scaleX(${progress / 100})` }}
        />
      </div>
      <h2 className="mt-4 text-sm font-bold text-balance">{phase.label}</h2>
      <p className="text-muted-foreground mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed text-pretty">
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
  const primaryRequest = requests[0];
  const phase = phaseForProgress(progress);
  const packetProgress = Math.min(PACKET_MAX_PROGRESS, Math.max(PACKET_MIN_PROGRESS, progress));

  return (
    <section
      aria-label="Feishu Bitable sync progress"
      className="sync-enter bg-card w-full max-w-[520px] rounded-2xl px-4 pt-5 pb-4 shadow-[var(--shadow-floating)]"
      style={
        {
          "--enter-delay": "70ms",
          "--sync-duration": `${SYNC_DURATION_MS}ms`,
          "--sync-progress": `${packetProgress}%`,
        } as CSSProperties
      }
    >
      <ConnectionRail progress={progress} request={primaryRequest} />
      <SyncFoldPreview request={primaryRequest} />
      <ProgressMeter progress={progress} phase={phase} />
      <BitablePreview requests={requests} progress={progress} />
    </section>
  );
}

function SyncSummary({ summary }: { summary: string }) {
  return (
    <div
      className="sync-enter mt-4 w-full max-w-[520px] rounded-2xl bg-accent px-3.5 py-3 shadow-[var(--shadow-border)]"
      style={{ "--enter-delay": "140ms" } as CSSProperties}
    >
      <div className="flex items-start gap-2.5">
        <ShieldCheck className="text-primary mt-0.5 size-4 shrink-0" />
        <div>
          <div className="text-accent-foreground text-xs font-bold">{summary}</div>
          <p className="text-accent-foreground/80 mt-0.5 text-[11px] leading-relaxed text-pretty">
            Bitable and Convex are updated as one workflow checkpoint.
          </p>
        </div>
        <ArrowRight className="text-primary ml-auto size-4 shrink-0" />
      </div>
    </div>
  );
}

export function SyncScreen({
  requests,
  clientEmail,
  coworkerCount,
}: {
  requests: SyncRequest[];
  clientEmail: string;
  coworkerCount: number;
}) {
  const progress = useSyncProgress();
  const summary = useMemo(() => {
    const requestLabel = `${requests.length} request${requests.length === 1 ? "" : "s"}`;
    const coworkerLabel = `${coworkerCount} coworker${coworkerCount === 1 ? "" : "s"}`;
    return `${clientEmail} -> ${requestLabel} -> ${coworkerLabel}`;
  }, [coworkerCount, clientEmail, requests.length]);

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-5 pt-6 pb-5">
      <SyncHeader />
      <SyncPanel requests={requests} progress={progress} />
      <SyncSummary summary={summary} />
    </div>
  );
}
