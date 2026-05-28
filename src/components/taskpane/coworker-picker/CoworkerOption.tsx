import * as React from "react";
import { Check, UserRound } from "lucide-react";
import type { Coworker } from "../coworkers";

export function CoworkerOption({
  coworker,
  selected,
  onSelect,
}: {
  coworker: Coworker;
  selected: boolean;
  onSelect: (coworker: Coworker) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(coworker)}
      className="bg-card flex w-full items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-[var(--shadow-border)] transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] active:scale-[0.97] data-[pressed=true]:bg-accent data-[pressed=true]:shadow-[0_0_0_1.5px_var(--primary)]"
      data-pressed={selected}
    >
      <span className="bg-secondary text-primary flex size-10 items-center justify-center rounded-full">
        <UserRound className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{coworker.name}</span>
        <span className="text-muted-foreground block truncate text-xs">Feishu coworker</span>
      </span>
      {selected ? <Check className="text-primary size-5" /> : null}
    </button>
  );
}
