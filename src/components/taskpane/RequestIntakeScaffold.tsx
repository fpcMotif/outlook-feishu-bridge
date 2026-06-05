import type { ReactNode } from "react";

// Intake page header (ADR-0020 second-pass UI). Hosts the profile slot inline on
// the right so the logged-in account controls + theme toggle ride the header row.
export function IntakeHeader({ profileSlot }: { profileSlot?: ReactNode }) {
  return (
    <header className="intake-stagger flex items-center justify-between gap-3 px-1 pt-3 pb-8">
      <h1 className="sync-enter min-w-0 flex-1 text-[34px] font-semibold leading-[0.98] tracking-tight text-balance">
        Sales Service
      </h1>
      {profileSlot ? <div>{profileSlot}</div> : null}
    </header>
  );
}
