import type { ReactNode } from "react";
import { Database, Mail } from "lucide-react";

import { cn } from "@/lib/utils";

function StatusOrb({
  icon,
  label,
  active,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col items-center gap-2">
      <div
        className={cn(
          "relative flex size-14 items-center justify-center rounded-full shadow-edge",
          active ? "bg-accent text-primary" : "bg-card-soft text-muted-foreground",
        )}
      >
        {active ? <span className="sync-orb-pulse absolute inset-0 rounded-full" /> : null}
        <span className="relative z-10">{icon}</span>
      </div>
      <span className="text-muted-foreground text-[11px] font-semibold">{label}</span>
    </div>
  );
}

export function ConnectionRail() {
  return (
    <div className="mt-1 flex shrink-0 items-start justify-between gap-3">
      <StatusOrb icon={<Mail className="size-6" />} label="Outlook" />
      <div className="relative h-14 min-w-0 flex-1" aria-hidden="true">
        <svg className="size-full overflow-visible" viewBox="0 0 100 64" preserveAspectRatio="none">
          <defs>
            <linearGradient id="sync-arc-light" x1="0" x2="1" y1="0" y2="0">
              <stop className="sync-arc-stop sync-arc-stop-1" offset="0%" />
              <stop className="sync-arc-stop sync-arc-stop-2" offset="28%" />
              <stop className="sync-arc-stop sync-arc-stop-3" offset="52%" />
              <stop className="sync-arc-stop sync-arc-stop-4" offset="76%" />
              <stop className="sync-arc-stop sync-arc-stop-5" offset="100%" />
            </linearGradient>
          </defs>
          <path
            d="M 3 31 C 27 -9 73 -9 97 31"
            fill="none"
            stroke="url(#sync-arc-light)"
            strokeLinecap="round"
            strokeWidth="4.5"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
      <StatusOrb icon={<Database className="size-6" />} label="Base" active />
    </div>
  );
}
