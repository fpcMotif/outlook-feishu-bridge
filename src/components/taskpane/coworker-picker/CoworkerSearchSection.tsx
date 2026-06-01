import type * as React from "react";

import { TaskpaneSearchDropdown } from "../TaskpaneSearchDropdown";

export function CoworkerSearchSection({
  query,
  onQueryChange,
  open,
  children,
}: {
  query: string;
  onQueryChange: (value: string) => void;
  open: boolean;
  children?: React.ReactNode;
}) {
  return (
    <section
      aria-labelledby="coworker-search-title"
      className="bg-card-soft mt-3 rounded-xl px-3 py-2 shadow-edge"
    >
      <div className="flex items-center justify-between gap-2 pb-2">
        <h2
          id="coworker-search-title"
          className="text-muted-foreground text-[11px] font-semibold uppercase"
        >
          Feishu coworker
        </h2>
      </div>
      <TaskpaneSearchDropdown
        label="Search Feishu coworkers"
        value={query}
        onChange={onQueryChange}
        placeholder="Search Feishu coworkers..."
        open={open}
        listLabel="Search results"
        emptyMessage={`No real Feishu coworkers match "${query}"`}
      >
        {children}
      </TaskpaneSearchDropdown>
    </section>
  );
}
