import { Check, MailWarning } from "lucide-react";

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

function StepRow({ step, last }: { step: Step; last: boolean }) {
  return (
    <div className="relative flex gap-3.5 pb-5 last:pb-0">
      {last ? null : <span className="bg-border absolute top-5 left-[8.5px] h-full w-px" />}
      <span
        className={cn(
          "relative z-10 mt-0.5 size-[18px] shrink-0 rounded-full border-[1.5px]",
          step.state === "done" && "border-primary bg-primary",
          step.state === "active" &&
            "border-primary bg-card shadow-[0_0_0_4px_color-mix(in_oklch,var(--primary)_18%,transparent)]",
        )}
      >
        {step.state === "active" ? (
          <span className="bg-primary animate-pulse-dot absolute inset-1 rounded-full" />
        ) : null}
      </span>
      <div className="-mt-px">
        <div className="text-foreground text-sm font-semibold">{step.title}</div>
        <div className="text-muted-foreground mt-0.5 text-xs">{step.sub}</div>
      </div>
    </div>
  );
}

function SuccessHalo() {
  return (
    <div className="relative mb-7 flex size-36 items-center justify-center">
      <span className="border-primary/30 animate-pulse-ring absolute inset-0 rounded-full border" />
      <span className="border-primary/30 animate-pulse-ring absolute inset-0 rounded-full border [animation-delay:0.8s]" />
      <span className="border-primary/30 animate-pulse-ring absolute inset-0 rounded-full border [animation-delay:1.6s]" />
      <span className="bg-primary text-primary-foreground animate-pop-in relative z-10 flex size-20 items-center justify-center rounded-full shadow-[var(--shadow-floating)]">
        <Check className="size-10" strokeWidth={2.4} />
      </span>
    </div>
  );
}

function buildSteps(coworkerCount: number): Step[] {
  return [
    { title: "Submitted", sub: "Just now", state: "done" },
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
      <div className="text-muted-foreground mt-3 inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1 text-xs">
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
          className="h-7 px-2 text-xs"
          onClick={onRetry}
        >
          Retry note-to-myself
        </Button>
      ) : null}
    </div>
  );
}

export function ReceivedScreen({
  coworkerCount,
  selfForwardStatus = null,
  onRetrySelfForward,
}: {
  coworkerCount: number;
  selfForwardStatus?: SelfForwardStatus;
  onRetrySelfForward?: () => void;
}) {
  const steps = buildSteps(coworkerCount);

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-12 pb-6">
      <SuccessHalo />

      <h1 className="text-3xl text-balance">Synced to Feishu</h1>
      <p className="text-muted-foreground mt-1.5 max-w-[34ch] text-center text-sm leading-relaxed text-pretty">
        The request is synced to Base, backed up in Convex, and ready for the selected coworker.
      </p>

      <SelfForwardChip status={selfForwardStatus} onRetry={onRetrySelfForward} />

      <div className="mt-9 w-full max-w-[320px]">
        {steps.map((s, i) => (
          <StepRow key={s.title} step={s} last={i === steps.length - 1} />
        ))}
      </div>

    </div>
  );
}
