import { Textarea } from "@/components/ui/textarea";

import { REQUESTS } from "./requests";

const NOTE_INPUT_SHELL =
  "group relative rounded-2xl bg-card-soft shadow-edge transition-[background-color,box-shadow] duration-200 ease-[var(--ease-out-strong)] focus-within:bg-card focus-within:ring-[3px] focus-within:ring-ring/20";

const CHAR_COUNTER_CLASS =
  "pointer-events-none absolute right-3 bottom-3 rounded-full border border-border/40 bg-background/90 px-2.5 py-1 text-[11px] leading-none font-medium text-muted-foreground tabular-nums";

export function RequestCards({
  values,
  onChange,
}: {
  values: Record<string, string>;
  onChange: (id: string, value: string) => void;
}) {
  const [primaryRequest] = REQUESTS;

  if (!primaryRequest) {
    return null;
  }

  const value = values[primaryRequest.id] ?? "";

  return (
    <section
      className={NOTE_INPUT_SHELL}
      aria-label="New request routing"
      data-request-note-card="true"
    >
      <Textarea
        value={value}
        onChange={(e) => onChange(primaryRequest.id, e.target.value)}
        placeholder={primaryRequest.placeholder}
        rows={4}
        className="min-h-[148px] rounded-2xl border-0 bg-transparent p-4 pb-10 shadow-none placeholder:text-[13px] placeholder:italic placeholder:font-normal focus-visible:bg-transparent focus-visible:ring-0"
      />
      <div className={CHAR_COUNTER_CLASS}>
        {value.length} char{value.length === 1 ? "" : "s"}
      </div>
    </section>
  );
}
