import { Check } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import type { Coworker } from "../coworkers";
import { initials } from "../initials";
import { dlog } from "../../../debug";

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
      data-search-option=""
      onClick={() => onSelect(coworker)}
      className="bg-card flex w-full cursor-pointer items-center gap-3 rounded-[14px] px-4 py-3 text-left shadow-edge transition-[background-color,box-shadow,scale] duration-150 ease-[var(--ease-out-strong)] outline-none active:scale-[0.97] data-[selected=true]:bg-accent data-[selected=true]:shadow-[0_0_0_1.5px_var(--primary)] focus-visible:ring-[3px] focus-visible:ring-ring/20"
      data-selected={selected}
    >
      <Avatar aria-hidden="true" className="size-10 bg-secondary">
        {coworker.avatarUrl ? (
          <AvatarImage
            src={coworker.avatarUrl}
            alt=""
            onLoadingStatusChange={(status) => {
              // Diagnostic only (ADR-0003 amendment): measure avatar-URL load
              // failures so the cache-TTL decision is data-driven. Radix already
              // renders the initials fallback on error — this changes no rendering.
              if (status === "error") dlog(`coworker avatar load error openId=${coworker.openId}`);
            }}
          />
        ) : null}
        <AvatarFallback className="bg-secondary text-primary text-sm font-semibold">
          {initials(coworker.name)}
        </AvatarFallback>
      </Avatar>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{coworker.name}</span>
        <span className="text-muted-foreground block truncate text-xs">Feishu coworker</span>
      </span>
      {selected ? <Check className="text-primary size-5" /> : null}
    </button>
  );
}
