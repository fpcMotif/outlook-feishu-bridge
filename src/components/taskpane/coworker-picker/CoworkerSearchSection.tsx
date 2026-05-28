import * as React from "react";
import { Search, X } from "lucide-react";

export function CoworkerSearchSection({
  query,
  focused,
  onQueryChange,
  onFocusChange,
}: {
  query: string;
  focused: boolean;
  onQueryChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <section
      aria-labelledby="coworker-search-title"
      className="bg-card mt-3 rounded-[18px] p-2 shadow-[var(--shadow-floating)]"
    >
      <div className="flex items-center px-2 pt-1 pb-2">
        <h1 id="coworker-search-title" className="text-sm font-bold">
          Feishu coworker
        </h1>
      </div>
      <SearchInput
        query={query}
        focused={focused}
        onQueryChange={onQueryChange}
        onFocusChange={onFocusChange}
      />
    </section>
  );
}

function SearchInput({
  query,
  focused,
  onQueryChange,
  onFocusChange,
}: {
  query: string;
  focused: boolean;
  onQueryChange: (value: string) => void;
  onFocusChange: (focused: boolean) => void;
}) {
  return (
    <div
      className={
        "bg-background flex items-center gap-2 rounded-xl px-3 shadow-[var(--shadow-border)] transition-[box-shadow] duration-150 " +
        (focused ? "ring-ring/10 ring-[3px]" : "")
      }
    >
      <Search className="text-primary size-4 shrink-0" />
      <input
        aria-label="Search Feishu coworkers"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        onFocus={() => onFocusChange(true)}
        onBlur={() => onFocusChange(false)}
        placeholder="Search Feishu coworkers..."
        className="placeholder:text-muted-foreground h-11 w-full bg-transparent text-sm outline-none"
      />
      {query ? (
        <button
          type="button"
          onClick={() => onQueryChange("")}
          aria-label="Clear search"
          className="text-muted-foreground hover:text-foreground inline-flex min-h-10 min-w-10 items-center justify-center"
        >
          <X className="size-4" />
        </button>
      ) : null}
    </div>
  );
}
