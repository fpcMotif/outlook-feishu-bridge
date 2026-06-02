import { createContext, useContext, type RefObject } from "react";

/** Shared boundary for the Customer & Coworker card — in-card clicks must not dismiss customer search. */
export const TaskpaneCardBoundaryContext = createContext<RefObject<HTMLElement | null> | null>(
  null,
);

export function useTaskpaneCardBoundary(): RefObject<HTMLElement | null> | null {
  return useContext(TaskpaneCardBoundaryContext);
}
