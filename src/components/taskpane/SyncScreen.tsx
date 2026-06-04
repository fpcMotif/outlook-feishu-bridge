import { useEffect, useState } from "react";

import type { CSSProperties } from "react";

import { TableProperties } from "lucide-react";



import { cn } from "@/lib/utils";



import { extOf, iconFor } from "./attachmentFileDisplay";

import { ConnectionRail } from "./SyncMotion";

import type { SyncPreviewAttachment, SyncPreviewNote, SyncPreviewPayload } from "./syncPreviewModel";

import {

  summarizeRequestNotes,

  syncPreviewAttachmentsVisible,

  syncPreviewRowSynced,

} from "./syncPreviewModel";



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



const PREVIEW_ATTACHMENT_COLLAPSED_LIMIT = 2;



function PreviewAttachmentRow({ name }: SyncPreviewAttachment) {

  const { Icon, tint, bg, border } = iconFor(name);

  const ext = extOf(name);



  return (

    <div className="flex min-w-0 items-center gap-2.5 py-2">

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

      <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-foreground">{name}</span>

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

  synced,

  dimmed,

}: {

  attachments: SyncPreviewAttachment[];

  synced: boolean;

  dimmed: boolean;

}) {

  const [expanded, setExpanded] = useState(false);

  const count = attachments.length;

  const collapsible = count > PREVIEW_ATTACHMENT_COLLAPSED_LIMIT;

  const hiddenCount = Math.max(0, count - PREVIEW_ATTACHMENT_COLLAPSED_LIMIT);

  const visible =

    expanded || !collapsible

      ? attachments

      : attachments.slice(0, PREVIEW_ATTACHMENT_COLLAPSED_LIMIT);

  const fileCountLabel = `${count} ${count === 1 ? "file" : "files"}`;



  return (

    <div

      className={cn(

        "sync-enter transition-opacity duration-300",

        dimmed ? "opacity-40" : "opacity-100",

      )}

      style={{ "--enter-delay": "140ms" } as CSSProperties}

    >

      <div

        className={cn(

          "overflow-hidden rounded-lg shadow-edge",

          synced ? "bg-background/80" : "bg-background/50",

        )}

      >

        <ul

          aria-label={fileCountLabel}

          className={cn(

            "divide-border/50 divide-y px-2.5",

            expanded && collapsible && "intake-stagger",

          )}

        >

          {visible.map((attachment, index) => (

            <li

              key={attachment.name}

              className={cn(

                expanded &&

                  collapsible &&

                  index >= PREVIEW_ATTACHMENT_COLLAPSED_LIMIT &&

                  "sync-enter",

              )}

              style={

                expanded && collapsible && index >= PREVIEW_ATTACHMENT_COLLAPSED_LIMIT

                  ? ({

                      "--enter-delay": `${(index - PREVIEW_ATTACHMENT_COLLAPSED_LIMIT) * 70}ms`,

                    } as CSSProperties)

                  : undefined

              }

            >

              <PreviewAttachmentRow name={attachment.name} />

            </li>

          ))}

        </ul>

        {collapsible ? (

          <button

            type="button"

            className={cn(

              "border-border/50 text-muted-foreground hover:text-foreground flex min-h-9 w-full items-center justify-center gap-1.5 border-t px-2.5 py-2 text-[11px] font-medium",

              "transition-transform duration-150 ease-[var(--ease-out-strong)] active:scale-[0.96]",

              "motion-reduce:active:scale-100",

            )}

            aria-expanded={expanded}

            onClick={() => setExpanded((current) => !current)}

          >

            {expanded ? (

              "Show less"

            ) : (

              <>

                <span>{`View more (+${hiddenCount})`}</span>

                <span className="text-muted-foreground/60 tabular-nums">{fileCountLabel}</span>

              </>

            )}

          </button>

        ) : null}

      </div>

    </div>

  );

}



function PreviewNotesSection({

  notes,

  synced,

}: {

  notes: SyncPreviewNote[];

  synced: boolean;

}) {

  const summary = summarizeRequestNotes(notes);



  return (

    <div>

      <div className="flex items-baseline justify-between gap-2">

        <p className="text-[10px] font-medium text-muted-foreground/75">{summary.sectionLabel}</p>

        {summary.countLabel ? (

          <p className="text-muted-foreground/60 shrink-0 text-[10px] tabular-nums">

            {summary.countLabel}

          </p>

        ) : null}

      </div>

      <div

        className={cn(

          "sync-enter mt-1.5 space-y-1 rounded-lg px-2.5 py-2 shadow-edge",

          synced ? "bg-background/80 text-foreground/90" : "bg-background/50 text-muted-foreground",

        )}

        style={{ "--enter-delay": "90ms" } as CSSProperties}

      >

        {summary.previewLines.map((line) => (

          <p

            key={line}

            className={cn(

              "text-pretty text-[11px] leading-relaxed",

              line.startsWith("+")

                ? "text-muted-foreground/70 text-[10px] tabular-nums"

                : undefined,

            )}

          >

            {line}

          </p>

        ))}

      </div>

    </div>

  );

}



function BasePreviewCard({

  preview,

  progress,

}: {

  preview: SyncPreviewPayload;

  progress: number;

}) {

  const rowSynced = syncPreviewRowSynced(progress);

  const attachmentsVisible = syncPreviewAttachmentsVisible(progress);

  const notes = preview.notes;

  const customerLine = preview.customerLabel?.trim() || "Customer";

  const hasAttachments = preview.attachments.length > 0;



  return (

    <div

      className="sync-enter mt-2.5 space-y-2.5"

      style={{ "--enter-delay": "120ms" } as CSSProperties}

    >

      <div>

        <p className="text-[10px] font-medium text-muted-foreground/75">Client</p>

        <p className="text-pretty text-sm font-semibold text-balance text-foreground">

          {customerLine}

        </p>

      </div>



      <PreviewNotesSection notes={notes} synced={rowSynced} />



      {hasAttachments ? (

        <PreviewAttachmentsSection

          attachments={preview.attachments}

          synced={rowSynced}

          dimmed={!attachmentsVisible}

        />

      ) : null}

    </div>

  );

}



function BasePreview({

  preview,

  progress,

}: {

  preview: SyncPreviewPayload;

  progress: number;

}) {

  return (

    <div className="mt-3 shrink-0 rounded-xl bg-card px-3 py-2.5 shadow-edge">

      <div className="flex items-baseline justify-between gap-3">

        <span className="text-muted-foreground inline-flex items-center gap-1.5 text-[10px] font-medium">

          <TableProperties className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />

          Base row preview

        </span>

        <span className="text-muted-foreground/70 shrink-0 text-[10px] font-medium tabular-nums">

          Live

        </span>

      </div>

      <BasePreviewCard preview={preview} progress={progress} />

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



function PhaseStatus({ phase }: { phase: (typeof PHASES)[number] }) {

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

  preview,

  progress,

}: {

  preview: SyncPreviewPayload;

  progress: number;

}) {

  const phase = phaseForProgress(progress);



  return (

    <section

      aria-label="Feishu Base sync progress"

      className="sync-enter bg-card flex w-full max-w-[420px] flex-none flex-col justify-start overflow-hidden rounded-2xl p-4 shadow-float sm:p-5"

      style={{ "--enter-delay": "70ms" } as CSSProperties}

    >

      <ProgressMeter progress={progress} />

      <ConnectionRail />

      <PhaseStatus phase={phase} />

      <BasePreview preview={preview} progress={progress} />

    </section>

  );

}



export function SyncScreen({ preview }: { preview: SyncPreviewPayload }) {

  const progress = useSyncProgress();



  return (

    <div className="no-scrollbar flex min-h-0 flex-1 overflow-y-auto px-5">

      <div className="flex min-h-full w-full flex-col items-center justify-center py-6">

        <SyncHeader />

        <SyncPanel preview={preview} progress={progress} />

      </div>

    </div>

  );

}


