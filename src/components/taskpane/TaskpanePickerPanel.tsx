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
  headerEnd,
  shellClassName,
  className,
  panelRef,
  onBlur,
  children,
}: {
  as?: PanelElement;
  title: string;
  titleId: string;
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
        <span id={titleId} className={TASKPANE_SEARCH_PANEL_TITLE}>
          {title}
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
