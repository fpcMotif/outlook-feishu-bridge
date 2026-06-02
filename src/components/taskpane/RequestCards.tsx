import { Textarea } from "@/components/ui/textarea";

import { REQUESTS } from "./requests";

const CARD_CLASS =
  "group bg-card rounded-[20px] p-2 shadow-edge transition-[background-color,box-shadow] duration-200 ease-[var(--ease-out-strong)] focus-within:ring-[3px] focus-within:ring-ring/15";

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
    <section className={CARD_CLASS} aria-label="New request routing" data-request-note-card="true">
      <div className="relative rounded-xl bg-card-soft transition-[background-color] duration-150 ease-[var(--ease-out-strong)] focus-within:bg-card">
        <Textarea
          value={value}
          onChange={(e) => onChange(primaryRequest.id, e.target.value)}
          placeholder={primaryRequest.placeholder}
          rows={4}
          className="min-h-[148px] rounded-xl bg-transparent px-4 py-4 pb-10 shadow-none placeholder:text-[13px] focus-visible:bg-transparent focus-visible:ring-0"
        />
        <div className="pointer-events-none absolute right-3 bottom-3 rounded-full bg-card/85 px-2 py-1 text-[11px] leading-none font-medium text-muted-foreground tabular-nums shadow-edge">
          {value.length} char{value.length === 1 ? "" : "s"}
        </div>
      </div>
    </section>
  );
}
