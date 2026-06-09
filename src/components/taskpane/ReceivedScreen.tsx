import type { CSSProperties } from "react";
import { Check, ExternalLink, MailWarning } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type StepState = "done" | "active";

interface Step {
  title: string;
  sub: string;
  state: StepState;
}

// ADR-0017: the parallel Self-Forward ("Note to myself") landed in the
// Initiator's own mailbox plus audit recipient — or didn't. `null` means we
// didn't try (dev preview
// without Office.js); the chip is hidden in that case.
type SelfForwardStatus = "pending" | "ok" | "failed" | null;

// Deferred attachment-fill lifecycle (ADR-0027), surfaced from
// getBitableSyncByConversation. `null` = no attachments were staged (nothing to
// wait for). The soft-gate treats `filled` and `null` as ready; the Sales fields'
// own write state never participates — empty / partial / full are all fine.
type AttachmentFillStatus = "pending" | "filling" | "filled" | "failed" | null;

function attachmentsReady(status: AttachmentFillStatus | undefined): boolean {
  return status == null || status === "filled";
}

import { relativeSubmittedTime } from "./relativeSubmittedTime";

function StepRow({ step, last }: { step: Step; last: boolean }) {
  return (
    <li className="relative flex gap-3.5 pb-4 last:pb-0">
      <div className="relative w-[18px] shrink-0">
        {last ? null : (
          <span className="bg-border/80 absolute top-5 left-1/2 -translate-x-1/2 h-full w-px" />
        )}
        <span
          className={cn(
            "relative z-10 mt-0.5 flex size-[18px] shrink-0 items-center justify-center rounded-full border-[1.5px]",
            step.state === "done" && "border-sage bg-sage text-background",
            step.state === "active" &&
              "border-primary bg-card shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_18%,transparent)]",
          )}
        >
          {step.state === "done" ? (
            <Check className="size-2.5" strokeWidth={3} aria-hidden />
          ) : step.state === "active" ? (
            <span className="bg-primary animate-pulse-dot absolute inset-1 rounded-full" />
          ) : null}
        </span>
      </div>
      <div className="-mt-px min-w-0">
        <div className="text-foreground text-sm font-semibold">
          {step.title}
        </div>
        <div className="text-muted-foreground mt-0.5 text-xs text-pretty">
          {step.sub}
        </div>
      </div>
    </li>
  );
}

function SuccessHalo() {
  return (
    <div className="relative mx-auto mb-4 flex size-28 items-center justify-center">
      <span className="border-primary/30 animate-pulse-ring absolute inset-0 rounded-full border" />
      <span className="bg-primary text-primary-foreground animate-pop-in relative z-10 flex size-16 items-center justify-center rounded-full shadow-float">
        <Check className="size-8" strokeWidth={2.4} />
      </span>
    </div>
  );
}

function buildSteps(
  coworkerCount: number,
  submittedAt?: number,
  attachmentStatus?: AttachmentFillStatus,
): Step[] {
  const steps: Step[] = [
    {
      title: "Submitted",
      sub: relativeSubmittedTime(submittedAt),
      state: "done",
    },
    {
      title: "Base row created",
      sub:
        coworkerCount > 0
          ? `${coworkerCount} coworker${coworkerCount > 1 ? "s" : ""} attached`
          : "Request details attached",
      state: "done",
    },
    {
      title: "Convex backup saved",
      sub: "Recovery record available",
      state: "done",
    },
  ];
  // Only show the attachment leg when there were attachments to fill. The Sales
  // fields can be empty/partial/full independently — they never gate this step.
  if (attachmentStatus != null) {
    const filled = attachmentStatus === "filled";
    const failed = attachmentStatus === "failed";
    steps.push({
      title: filled
        ? "Attachments synced"
        : failed
          ? "Attachments incomplete"
          : "Uploading attachments",
      sub: filled
        ? "Files on the Base row"
        : failed
          ? "Some files couldn't attach — reopening retries"
          : "Writing files to the Base row…",
      state: filled ? "done" : "active",
    });
  }
  return steps;
}

function SelfForwardChip({
  status,
  onRetry,
}: {
  status: SelfForwardStatus;
  onRetry?: () => void;
}) {
  if (status === null) return null;
  if (status === "ok") return null;
  if (status === "pending") {
    return (
      <div className="text-muted-foreground mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted/80 px-3 py-1 text-xs">
        Sending Note to myself…
      </div>
    );
  }
  return (
    <div className="mt-3 flex flex-col items-center gap-1.5">
      <div className="text-destructive inline-flex items-center gap-1.5 rounded-full bg-destructive/10 px-3 py-1 text-xs">
        <MailWarning className="size-3.5" />
        Note-to-myself failed
      </div>
      {onRetry ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 text-xs transition-transform active:scale-[0.96]"
          onClick={onRetry}
        >
          Retry note-to-myself
        </Button>
      ) : null}
    </div>
  );
}

function BitableRecordAction({
  recordId,
  detailUrl,
  attachmentStatus,
}: {
  recordId?: string | null;
  detailUrl?: string | null;
  attachmentStatus?: AttachmentFillStatus;
}) {
  if (!detailUrl) {
    if (!recordId) return null;
    return (
      <div className="bg-muted/80 text-muted-foreground mt-4 rounded-md px-3 py-1.5 text-xs">
        Base record {recordId}
      </div>
    );
  }

  const ready = attachmentsReady(attachmentStatus);
  const link = (
    <a
      href={detailUrl}
      target="_blank"
      rel="noreferrer"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20",
        ready ? "text-primary mt-3" : "text-muted-foreground",
      )}
    >
      <ExternalLink className="size-3.5" />
      {ready ? "Open in Feishu" : "Open in Feishu anyway"}
    </a>
  );

  // The row exists the instant it is created, so the link always works. The soft
  // gate keeps it secondary — under an "uploading…" chip — until the deferred fill
  // fences `filled`, then it becomes the primary CTA (ADR-0027).
  if (ready) return link;
  return (
    <div className="mt-3 flex flex-col items-center gap-1.5">
      <div
        className={cn(
          "inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs",
          attachmentStatus === "failed"
            ? "text-destructive bg-destructive/10"
            : "text-muted-foreground bg-muted/80",
        )}
      >
        {attachmentStatus === "failed"
          ? "Some attachments couldn't finish"
          : "Uploading attachments…"}
      </div>
      {link}
    </div>
  );
}

function ReceivedTimeline({ steps }: { steps: Step[] }) {
  return (
    <ol
      aria-label="Sync completion steps"
      className="sync-enter row-start-3 mt-6 w-fit max-w-[320px] flex-none list-none p-0"
      style={{ "--enter-delay": "70ms" } as CSSProperties}
    >
      {steps.map((s, i) => (
        <StepRow key={s.title} step={s} last={i === steps.length - 1} />
      ))}
    </ol>
  );
}

export function ReceivedScreen({
  coworkerCount,
  recordId,
  detailUrl,
  submittedAt,
  devFixtureLabel,
  alreadySynced = false,
  selfForwardStatus = null,
  onRetrySelfForward,
  attachmentStatus,
}: {
  coworkerCount: number;
  recordId?: string | null;
  detailUrl?: string | null;
  submittedAt?: number;
  devFixtureLabel?: string;
  alreadySynced?: boolean;
  selfForwardStatus?: SelfForwardStatus;
  onRetrySelfForward?: () => void;
  attachmentStatus?: AttachmentFillStatus;
}) {
  const steps = buildSteps(coworkerCount, submittedAt, attachmentStatus);

  return (
    <div className="bg-background text-foreground no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8">
      <div className="intake-stagger grid min-h-0 flex-1 -translate-y-3 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] justify-items-center py-7">
        <header className="sync-enter row-start-2 w-full max-w-[420px] shrink-0 px-1 text-center">
          <SuccessHalo />
          {devFixtureLabel ? (
            <div className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
              {devFixtureLabel}
            </div>
          ) : null}
          <h1 className="text-foreground text-[clamp(1.5rem,5vw,1.875rem)] leading-[1.05] font-semibold tracking-tight text-balance">
            {alreadySynced ? "Already synced" : "Synced"}
          </h1>
          <BitableRecordAction
            recordId={recordId}
            detailUrl={detailUrl}
            attachmentStatus={attachmentStatus}
          />
          <SelfForwardChip
            status={selfForwardStatus}
            onRetry={onRetrySelfForward}
          />
        </header>
        <ReceivedTimeline steps={steps} />
      </div>
    </div>
  );
}
