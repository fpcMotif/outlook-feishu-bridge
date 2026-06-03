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
        <div className="text-foreground text-sm font-semibold">{step.title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs text-pretty">{step.sub}</div>
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

function buildSteps(coworkerCount: number, submittedAt?: number): Step[] {
  return [
    { title: "Submitted", sub: relativeSubmittedTime(submittedAt), state: "done" },
    {
      title: "Base row created",
      sub:
        coworkerCount > 0
          ? `${coworkerCount} coworker${coworkerCount > 1 ? "s" : ""} attached`
          : "Request details attached",
      state: "done",
    },
    { title: "Convex backup saved", sub: "Recovery record available", state: "done" },
  ];
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
}: {
  recordId?: string | null;
  detailUrl?: string | null;
}) {
  if (detailUrl) {
    return (
      <a
        href={detailUrl}
        target="_blank"
        rel="noreferrer"
        className="text-primary mt-3 inline-flex items-center gap-1.5 rounded-sm text-sm font-medium underline-offset-4 transition-colors hover:underline focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/20"
      >
        <ExternalLink className="size-3.5" />
        Open in Feishu
      </a>
    );
  }
  if (!recordId) return null;
  return (
    <div className="bg-muted/80 text-muted-foreground mt-4 rounded-md px-3 py-1.5 text-xs">
      Base record {recordId}
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
}: {
  coworkerCount: number;
  recordId?: string | null;
  detailUrl?: string | null;
  submittedAt?: number;
  devFixtureLabel?: string;
  alreadySynced?: boolean;
  selfForwardStatus?: SelfForwardStatus;
  onRetrySelfForward?: () => void;
}) {
  const steps = buildSteps(coworkerCount, submittedAt);

  return (
    <div
      className="no-scrollbar flex min-h-0 flex-1 flex-col overflow-y-auto px-5 py-8"
      style={{ backgroundColor: "var(--login-background)" }}
    >
      <div className="intake-stagger grid min-h-0 flex-1 -translate-y-3 grid-rows-[minmax(0,1fr)_auto_minmax(0,1fr)] justify-items-center py-7">
        <header className="sync-enter row-start-2 w-full max-w-[420px] shrink-0 px-1 text-center">
          <SuccessHalo />
          {devFixtureLabel ? (
            <div className="text-muted-foreground mb-2 text-[11px] font-semibold uppercase tracking-[0.08em]">
              {devFixtureLabel}
            </div>
          ) : null}
          <h1 className="text-[clamp(1.5rem,5vw,1.875rem)] leading-[1.05] text-balance">
            {alreadySynced ? "Already synced" : "Synced"}
          </h1>
          <BitableRecordAction recordId={recordId} detailUrl={detailUrl} />
          <SelfForwardChip status={selfForwardStatus} onRetry={onRetrySelfForward} />
        </header>
        <ReceivedTimeline steps={steps} />
      </div>
    </div>
  );
}
