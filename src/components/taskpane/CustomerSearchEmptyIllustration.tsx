import { FolderSearch, SearchX, type LucideIcon } from "lucide-react";
import type { CustomerSearchEmptyKind } from "./customerSearchHelpers";

const ILLUSTRATIONS: Record<
  CustomerSearchEmptyKind,
  { Icon: LucideIcon; opticalClassName: string }
> = {
  // Filtered directory scope is empty — browse/search the "mine" collection, zero rows.
  "show-mine-no-owned": {
    Icon: FolderSearch,
    opticalClassName: "-translate-y-px",
  },
  // Active query under the owner filter returned nothing.
  "show-mine-no-match": {
    Icon: SearchX,
    opticalClassName: "-translate-y-px",
  },
};

export function CustomerSearchEmptyIllustration({ kind }: { kind: CustomerSearchEmptyKind }) {
  const { Icon, opticalClassName } = ILLUSTRATIONS[kind];

  return (
    <span
      aria-hidden
      className="bg-secondary/10 flex size-10 shrink-0 items-center justify-center rounded-full"
    >
      <Icon
        className={`text-muted-foreground sync-enter size-5 ${opticalClassName}`}
        strokeWidth={1.5}
      />
    </span>
  );
}
