import { createContext, use, type RefObject } from "react";

/** Shared boundary for the Customer & Coworker card — in-card clicks must not dismiss customer search. */
export const TaskpaneCardBoundaryContext = createContext<RefObject<HTMLElement | null> | null>(
  null,
);

function useTaskpaneCardBoundary(): RefObject<HTMLElement | null> | null {
  return use(TaskpaneCardBoundaryContext);
}
