import { Plus, Search } from "lucide-react";

// Lenient no-match (ADR-0013): tell the salesperson the auto-match found
// nothing and reserve a placeholder for the future create-new affordance, but
// do not block the sync. A search icon button lets them override manually.
export function CustomerPickerNoMatch({ onSearch }: { onSearch: () => void }) {
  return (
    <span className="flex min-w-0 flex-1 items-center gap-1">
      <span
        className="text-muted-foreground min-w-0 flex-1 whitespace-normal break-words text-xs leading-4"
        title="No matched"
      >
        No matched
      </span>
      <button
        type="button"
        onClick={onSearch}
        aria-label="Search customer"
        className="text-primary hover:bg-accent inline-flex size-10 shrink-0 items-center justify-center rounded-full transition-colors active:scale-[0.96]"
      >
        <Search className="size-4" />
      </button>
      <button
        type="button"
        disabled
        aria-label="Add new customer (coming soon)"
        className="text-muted-foreground inline-flex size-10 shrink-0 items-center justify-center rounded-full opacity-40"
      >
        <Plus className="size-4" />
      </button>
    </span>
  );
}
