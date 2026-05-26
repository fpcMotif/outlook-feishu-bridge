import { ArrowRight, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export function SubmitDock({
  count,
  canSubmit,
  sending,
  hint,
  footer,
  onSubmit,
}: {
  count: number;
  canSubmit: boolean;
  sending: boolean;
  hint: string;
  footer?: string;
  onSubmit: () => void;
}) {
  const live = canSubmit && !sending;
  return (
    <div className="bg-background relative z-10 shrink-0 px-5 pt-3 pb-2">
      <div className="from-background pointer-events-none absolute inset-x-0 -top-6 h-6 bg-gradient-to-t to-transparent" />
      <button
        type="button"
        onClick={onSubmit}
        disabled={!live}
        className={cn(
          "flex h-14 w-full items-center justify-between rounded-[18px] px-5 text-[15px] font-semibold transition-all",
          live
            ? "bg-primary text-primary-foreground shadow-primary/35 hover:bg-primary-deep shadow-lg active:scale-[0.99]"
            : "bg-secondary text-muted-foreground cursor-not-allowed",
        )}
      >
        <span className="inline-flex items-center gap-2">
          {sending ? <Loader2 className="size-4 animate-spin" /> : null}
          {sending
            ? "Submitting…"
            : count > 0
              ? `Submit ${count} request${count > 1 ? "s" : ""}`
              : hint}
        </span>
        {live && count > 0 ? <ArrowRight className="size-[18px]" /> : null}
      </button>
      <div className="text-muted-foreground mt-2 truncate text-center text-[11px]">
        {footer ?? "Encrypted · routed to your Feishu workspace"}
      </div>
    </div>
  );
}
