import type { CustomerSearchEmptyKind } from "./customerSearchHelpers";
import { Button } from "../ui/button";

export function CustomerSearchEmptyState({
  kind,
  query,
  onShowAll,
  onClearSearch,
}: {
  kind: CustomerSearchEmptyKind;
  query: string;
  onShowAll: () => void;
  onClearSearch: () => void;
}) {
  const trimmedQuery = query.trim();
  const title =
    kind === "show-mine-no-owned"
      ? "No customers assigned to you"
      : "No matches among your customers";
  const description =
    kind === "show-mine-no-owned"
      ? "Show mine is on, but you don't own any customers in this directory yet."
      : `Nothing you own matches "${trimmedQuery}". Try a different search or show all customers.`;

  return (
    <div className="bg-card sync-enter rounded-xl p-3 text-center shadow-edge">
      <p className="text-foreground text-balance text-sm font-semibold">{title}</p>
      <p className="text-muted-foreground text-pretty mt-1 text-xs leading-4">{description}</p>
      <div className="mt-3 flex flex-wrap justify-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onShowAll}>
          Show all customers
        </Button>
        {kind === "show-mine-no-match" ? (
          <Button type="button" variant="ghost" size="sm" onClick={onClearSearch}>
            Clear search
          </Button>
        ) : null}
      </div>
    </div>
  );
}
