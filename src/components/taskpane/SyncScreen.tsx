/* eslint-disable max-lines -- cohesive sync progress/preview screen; function caps stay active. */
import { useEffect, useState } from "react";

import type { CSSProperties } from "react";

import { MessageSquareText, TableProperties } from "lucide-react";

import { cn } from "@/lib/utils";

import { extOf, iconFor } from "./attachmentFileDisplay";

import { ConnectionRail } from "./SyncMotion";

import type { SyncPhase } from "./intakeReducer";

import type {
  SyncPreviewAttachment,
  SyncPreviewNote,
  SyncPreviewPayload,
} from "./syncPreviewModel";

import { summarizeRequestNotes } from "./syncPreviewModel";

import { SYNC_PHASE_VIEW, syncPhaseView } from "./syncPhaseView";

import type { SyncPhaseView } from "./syncPhaseView";

const PROGRESS_TICK_MS = 90;

// Phase-driven meter: ease toward the current leg's ceiling (decelerating, so it
// never claims completion early) and snap to 100% the moment the row exists. No
// setInterval clock and no fake 98% stall — the number tracks the real sync.
// The ceiling (like every other view decision) comes from SYNC_PHASE_VIEW.
function usePhaseProgress(phase: SyncPhase) {
  const [progress, setProgress] = useState(6);

  useEffect(() => {
    const ceiling = SYNC_PHASE_VIEW[phase].ceiling;
    if (phase === "finalizing") {
      setProgress(ceiling);
      return;
    }
    const timer = window.setInterval(() => {
      setProgress((current) => {
        if (current >= ceiling) return current;
        const step = Math.max(1, Math.ceil((ceiling - current) * 0.16));
        return Math.min(ceiling, current + step);
      });
    }, PROGRESS_TICK_MS);
    return () => window.clearInterval(timer);
  }, [phase]);

  return progress;
}

const PREVIEW_ATTACHMENT_COLLAPSED_LIMIT = 2;

function PreviewAttachmentRow({ name }: SyncPreviewAttachment) {
  const { Icon, tint, bg, border } = iconFor(name);

  const ext = extOf(name);

  return (
    <div className="flex min-w-0 items-center gap-2.5 overflow-hidden py-1.5">
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-lg border",

          bg,

          border,
        )}
        aria-hidden="true"
      >
        <Icon className={cn("size-4", tint)} strokeWidth={1.75} />
      </span>

      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">
        {name}
      </span>

      {ext ? (
        <span className="text-muted-foreground/80 shrink-0 text-[10px] font-medium uppercase tracking-wide tabular-nums">
          {ext}
        </span>
      ) : null}
    </div>
  );
}

function PreviewAttachmentsSection({
  attachments,

  dimmed,
}: {
  attachments: SyncPreviewAttachment[];

  dimmed: boolean;
}) {
  const count = attachments.length;

  const hiddenCount = Math.max(0, count - PREVIEW_ATTACHMENT_COLLAPSED_LIMIT);

  const visible = attachments.slice(0, PREVIEW_ATTACHMENT_COLLAPSED_LIMIT);

  const fileCountLabel = `${count} ${count === 1 ? "file" : "files"}`;

  return (
    <div
      className={cn(
        "border-border/50 min-w-0 overflow-hidden border-t transition-opacity duration-300",

        dimmed ? "opacity-40" : "opacity-100",
      )}
    >
      <ul
        aria-label={fileCountLabel}
        className="divide-border/50 min-w-0 divide-y overflow-hidden px-2.5"
      >
        {visible.map((attachment) => (
          <li key={attachment.name}>
            <PreviewAttachmentRow name={attachment.name} />
          </li>
        ))}
      </ul>

      {hiddenCount > 0 ? (
        <div className="border-border/50 flex min-w-0 items-center justify-between gap-2 overflow-hidden border-t px-2.5 py-1.5">
          <span className="text-muted-foreground/80 min-w-0 truncate text-[10px] font-medium">
            {`+${hiddenCount} more ${hiddenCount === 1 ? "file" : "files"}`}
          </span>

          <span className="text-muted-foreground/50 shrink-0 text-[10px] font-medium tabular-nums">
            {fileCountLabel}
          </span>
        </div>
      ) : null}
    </div>
  );
}

function PreviewNotesSection({ notes }: { notes: SyncPreviewNote[] }) {
  const summary = summarizeRequestNotes(notes);

  // Several notes → one line each (calm, predictable height); a lone note gets two.
  const dense = summary.previewLines.length > 1;

  const contentLines = summary.previewLines.filter((line) => !line.startsWith("+"));

  const moreLine = summary.previewLines.find((line) => line.startsWith("+"));

  return (
    <div className="border-border/50 min-w-0 overflow-hidden border-t">
      <ul className="divide-border/50 min-w-0 divide-y overflow-hidden px-2.5">
        {contentLines.map((line) => (
          <li key={line} className="flex min-w-0 items-center gap-2.5 overflow-hidden py-1.5">
            <span
              className="bg-card-soft border-border/60 flex size-7 shrink-0 items-center justify-center rounded-lg border"
              aria-hidden="true"
            >
              <MessageSquareText className="text-muted-foreground size-3.5" strokeWidth={1.75} />
            </span>

            <span
              className={cn(
                "min-w-0 flex-1 text-pretty text-[11px] leading-relaxed break-words text-foreground/90",

                dense ? "line-clamp-1" : "line-clamp-2",
              )}
            >
              {line}
            </span>
          </li>
        ))}
      </ul>

      {moreLine ? (
        <div className="border-border/50 text-muted-foreground/70 border-t px-2.5 py-1.5 text-[10px] font-medium tabular-nums">
          {moreLine}
        </div>
      ) : null}
    </div>
  );
}

function BasePreviewCard({
  preview,

  rowLanded,

  attachmentsSettled,
}: {
  preview: SyncPreviewPayload;

  rowLanded: boolean;

  attachmentsSettled: boolean;
}) {
  const notes = preview.notes;

  const customerLine = preview.customerLabel?.trim() || "Customer";

  const hasAttachments = preview.attachments.length > 0;

  return (
    <div
      className={cn(
        "sync-enter mt-2.5 min-w-0 overflow-hidden rounded-lg shadow-edge transition-colors duration-300",

        rowLanded ? "bg-background/80" : "bg-background/50",
      )}
      style={{ "--enter-delay": "120ms" } as CSSProperties}
    >
      <div className="min-w-0 overflow-hidden px-2.5 pt-2 pb-1.5">
        <p className="text-[10px] font-medium text-muted-foreground/75">Client</p>

        <p className="min-w-0 truncate text-sm font-semibold text-foreground">{customerLine}</p>
      </div>

      <PreviewNotesSection notes={notes} />

      {hasAttachments ? (
        <PreviewAttachmentsSection
          attachments={preview.attachments}
          dimmed={!attachmentsSettled}
        />
      ) : null}
    </div>
  );
}

function BasePreview({
  preview,

  rowLanded,

  attachmentsSettled,
}: {
  preview: SyncPreviewPayload;

  rowLanded: boolean;

  attachmentsSettled: boolean;
}) {
  return (
    <div className="mt-3 min-w-0 shrink-0 overflow-hidden rounded-xl bg-card px-3 py-2.5 shadow-edge">
      <div className="flex min-w-0 items-baseline justify-between gap-3">
        <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1.5 truncate text-[10px] font-medium">
          <TableProperties className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
          Base row preview
        </span>

        <span className="text-muted-foreground/70 shrink-0 text-[10px] font-medium tabular-nums">
          Live
        </span>
      </div>

      <BasePreviewCard
        preview={preview}
        rowLanded={rowLanded}
        attachmentsSettled={attachmentsSettled}
      />
    </div>
  );
}

function SyncHeader() {
  return (
    <header className="sync-enter w-full max-w-[420px] shrink-0 px-1 pb-3 text-center">
      <h1 className="text-[clamp(1.5rem,5vw,2.0625rem)] leading-[1.05] text-balance">
        Syncing to <br />
        Feishu Base&hellip;
      </h1>
    </header>
  );
}

function ProgressMeter({ progress }: { progress: number }) {
  return (
    <div className="shrink-0 pt-1 pb-2 text-center">
      <div className="text-primary text-[clamp(2.25rem,10vw,3.375rem)] leading-[1.08] font-semibold tabular-nums tracking-tight">
        {progress}%
      </div>

      <progress className="sr-only" value={progress} max={100} aria-label="Sync progress" />
    </div>
  );
}

function PhaseStatus({ phaseView }: { phaseView: SyncPhaseView }) {
  return (
    <div className="mt-2 shrink-0 text-center">
      <h2 className="text-muted-foreground text-sm font-normal italic text-balance">
        {phaseView.label}
      </h2>

      <p className="text-muted-foreground/70 mx-auto mt-1 max-w-[30ch] text-xs leading-relaxed font-light text-pretty">
        {phaseView.detail}
      </p>
    </div>
  );
}

function SyncPanel({
  preview,
  progress,
  phaseView,
}: {
  preview: SyncPreviewPayload;
  progress: number;
  phaseView: SyncPhaseView;
}) {
  return (
    <section
      aria-label="Feishu Base sync progress"
      className="sync-enter bg-card flex w-full max-w-[420px] flex-none flex-col justify-start overflow-hidden rounded-2xl p-4 shadow-float sm:p-5"
      style={{ "--enter-delay": "70ms" } as CSSProperties}
    >
      <ProgressMeter progress={progress} />

      <ConnectionRail />

      <PhaseStatus phaseView={phaseView} />

      <BasePreview
        preview={preview}
        rowLanded={phaseView.rowLanded}
        attachmentsSettled={phaseView.attachmentsSettled}
      />
    </section>
  );
}

export function SyncScreen({
  preview,
  // Default conservatively to the first leg: a cold-open overlay only knows the
  // sync is "pending", not which milestone it reached, so it must not claim the
  // row is already being written.
  phase = "staging",
}: {
  preview: SyncPreviewPayload;
  phase?: SyncPhase;
}) {
  const progress = usePhaseProgress(phase);
  const phaseView = syncPhaseView(phase);

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 overflow-y-auto px-5">
      <div className="flex min-h-full w-full flex-col items-center justify-center py-6">
        <SyncHeader />

        <SyncPanel preview={preview} progress={progress} phaseView={phaseView} />
      </div>
    </div>
  );
}
