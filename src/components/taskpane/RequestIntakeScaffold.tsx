import type { ReactNode } from "react";
import { SalesServiceLogo } from "./SalesServiceLogo";

// Intake page header (ADR-0020 second-pass UI). Hosts the profile slot inline on
// the right so the logged-in account controls + theme toggle ride the header row.
export function IntakeHeader({ profileSlot }: { profileSlot?: ReactNode }) {
  return (
    <header className="intake-stagger flex items-center justify-between gap-3 px-1 pt-3 pb-8">
      <h1 className="sync-enter flex items-center min-w-0 flex-1">
        <span className="sr-only">Sales Service</span>
        {/* Optical nudge: the flask's mass (its circular body) sits in the lower
            half of the canvas, so a geometrically centered logo reads ~2px low
            next to the solid avatar circle. Lift it to align the two visually. */}
        <SalesServiceLogo className="h-8 w-auto -translate-y-[2px]" />
      </h1>
      {profileSlot ? <div className="flex items-center">{profileSlot}</div> : null}
    </header>
  );
}
