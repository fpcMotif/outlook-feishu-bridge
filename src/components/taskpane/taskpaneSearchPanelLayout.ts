/** Standalone customer search card (not stacked in the intake card). */
export const TASKPANE_SEARCH_PANEL_SHELL = "px-3 py-2";

/** Stacked intake card rows — slightly roomier vertical padding for balanced search panel framing. */
export const TASKPANE_SEARCH_PANEL_SHELL_STACKED = "px-3 py-2";

/** Top row in the stacked card (customer search above the inset divider). */
export const TASKPANE_SEARCH_PANEL_SHELL_HEADER = TASKPANE_SEARCH_PANEL_SHELL_STACKED;

/** Bottom row in the stacked card (coworker search). */
export const TASKPANE_SEARCH_PANEL_SHELL_FOOTER = TASKPANE_SEARCH_PANEL_SHELL_STACKED;

/** Header row; fixed height keeps the title pinned while only the body swaps. */
export const TASKPANE_SEARCH_PANEL_HEADER =
  "flex h-7 items-center justify-between gap-2";

export const TASKPANE_SEARCH_PANEL_TITLE =
  "text-muted-foreground text-[11px] font-semibold uppercase";

/** Inset hairline between stacked rows inside a bg-card-soft shell. */
export const TASKPANE_INSET_DIVIDER =
  "mx-3 h-px shrink-0 bg-[color-mix(in_oklch,var(--border)_42%,transparent)]";
