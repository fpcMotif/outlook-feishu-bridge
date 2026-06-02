import { TASKPANE_INSET_DIVIDER } from "./taskpaneSearchPanelLayout";

/** Subtle inset separator between stacked intake rows (customer ↔ coworker). */
export function TaskpaneInsetDivider() {
  return <div className={TASKPANE_INSET_DIVIDER} role="separator" aria-hidden="true" />;
}
