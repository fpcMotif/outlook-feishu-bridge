import type { CustomerSearchEmptyKind } from "./customerSearchHelpers";
import { CustomerSearchEmptyIllustration } from "./CustomerSearchEmptyIllustration";
import { Button } from "../ui/button";

export function CustomerSearchEmptyState({
  kind,
  onClearSearch,
}: {
  kind: CustomerSearchEmptyKind;
  onClearSearch: () => void;
}) {
  const title =
    kind === "show-mine-no-owned"
      ? "No customers assigned to you"
      : "No matches among your customers";

  return (
    <div className="bg-card rounded-xl p-3 text-center shadow-edge">
      <div className="flex flex-col items-center gap-2">
        <CustomerSearchEmptyIllustration kind={kind} />
        <p className="text-muted-foreground text-balance text-sm font-light italic">{title}</p>
      </div>
      {kind === "show-mine-no-match" ? (
        <div className="mt-3 flex flex-wrap justify-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        </div>
      ) : null}
    </div>
  );
}
