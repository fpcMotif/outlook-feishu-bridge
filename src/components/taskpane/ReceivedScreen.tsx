import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

type StepState = "done" | "active";

interface Step {
  title: string;
  sub: string;
  state: StepState;
}

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
      title: "Bitable row created",
      sub:
        coworkerCount > 0
          ? `${coworkerCount} coworker${coworkerCount > 1 ? "s" : ""} attached`
          : "Request details attached",
      state: "done",
    },
    { title: "Convex backup saved", sub: "Recovery record available", state: "done" },
  ];
}

export function ReceivedScreen({
  coworkerCount,
  onForwardAnother,
}: {
  coworkerCount: number;
  onForwardAnother: () => void;
}) {
  const steps = buildSteps(coworkerCount);

  return (
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pt-12 pb-6">
      <SuccessHalo />

      <h1 className="font-serif text-3xl text-balance">Synced to Feishu</h1>
      <p className="text-muted-foreground mt-1.5 max-w-[34ch] text-center text-sm leading-relaxed text-pretty">
        The request is synced to Bitable, backed up in Convex, and ready for the selected coworker.
      </p>

      <div className="mt-9 w-full max-w-[320px]">
        {steps.map((s, i) => (
          <StepRow key={s.title} step={s} last={i === steps.length - 1} />
        ))}
      </div>

      <div className="mt-auto w-full max-w-[320px] pt-8">
        <Button className="h-12 w-full rounded-2xl text-[15px]" onClick={onForwardAnother}>
          Route another email
        </Button>
      </div>
    </div>
  );
}
