import { TASKPANE_INSET_DIVIDER } from "./taskpaneSearchPanelLayout";

/** Subtle inset separator between stacked intake rows (customer ↔ coworker). */
export function TaskpaneInsetDivider() {
  return <hr className={TASKPANE_INSET_DIVIDER} aria-hidden="true" />;
}
