/* eslint-disable max-lines-per-function -- one cohesive panel shell; the branch is just div-vs-section. */
import type { FocusEventHandler, ReactNode, Ref } from "react";

import { cn } from "@/lib/utils";
import {
  TASKPANE_SEARCH_PANEL_HEADER,
  TASKPANE_SEARCH_PANEL_TITLE,
} from "./taskpaneSearchPanelLayout";

type PanelElement = "div" | "section";

export function TaskpanePickerPanel({
  as = "div",
  title,
  titleId,
  srTitle,
  headerEnd,
  shellClassName,
  className,
  panelRef,
  onBlur,
  children,
}: {
  as?: PanelElement;
  /** Terse visual chip (e.g. "customer"); rendered uppercase, hidden from AT. */
  title: string;
  titleId: string;
  /**
   * Full accessible name announced to screen readers for the labelled region.
   * The visible `title` is a compact chip ("customer", "sales") whose terseness
   * reads poorly to assistive tech, so AT gets this fuller heading instead.
   * Defaults to `title` when omitted.
   */
  srTitle?: string;
  headerEnd?: ReactNode;
  shellClassName: string;
  className?: string;
  panelRef?: Ref<HTMLDivElement> | Ref<HTMLElement>;
  onBlur?: FocusEventHandler<HTMLElement>;
  children: ReactNode;
}) {
  const panelClassName = cn(shellClassName, className);
  const content = (
    <>
      <div className={TASKPANE_SEARCH_PANEL_HEADER}>
        {/* Visible chip is decorative; the region's accessible name comes from the
            sr-only full heading at `titleId` (aria-labelledby target below). */}
        <span aria-hidden="true" className={TASKPANE_SEARCH_PANEL_TITLE}>
          {title}
        </span>
        <span id={titleId} className="sr-only">
          {srTitle ?? title}
        </span>
        {headerEnd ? <div className="flex items-center gap-1">{headerEnd}</div> : null}
      </div>
      {children}
    </>
  );

  if (as === "section") {
    return (
      <section
        ref={panelRef as Ref<HTMLElement>}
        onBlur={onBlur}
        className={panelClassName}
        aria-labelledby={titleId}
      >
        {content}
      </section>
    );
  }

  return (
    <div
      ref={panelRef as Ref<HTMLDivElement>}
      onBlur={onBlur as FocusEventHandler<HTMLDivElement> | undefined}
      className={panelClassName}
      aria-labelledby={titleId}
    >
      {content}
    </div>
  );
}
