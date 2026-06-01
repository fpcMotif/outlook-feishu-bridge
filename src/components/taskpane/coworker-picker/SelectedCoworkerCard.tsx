import { Check } from "lucide-react";

import type { Coworker } from "../coworkers";

export function SelectedCoworkerCard({ coworker }: { coworker: Coworker }) {
  return (
    <div className="bg-accent text-accent-foreground border-accent-foreground/15 mt-2 flex items-center gap-2 rounded-xl border px-3 py-2 shadow-edge">
      <Check className="text-primary size-4 shrink-0" />
      <span className="text-muted-foreground text-[11px] font-semibold uppercase">Selected</span>
      <span className="min-w-0 truncate text-sm font-semibold">{coworker.name}</span>
    </div>
  );
}
