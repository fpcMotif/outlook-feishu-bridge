/** Brief pause after paint so the empty sales prompt reads before self-default. */
export const SALES_DEFAULT_DELAY_MS = 2500;

// The "Pick a sale" glimpse before Sales auto-fills with the Initiator is a
// FIRST-LOAD onboarding affordance only. Once the signed-in user has been
// defaulted once in this SPA session, later applications — e.g. when a pinned
// pane switches conversation and Sales reverts to the Initiator (ADR-0025) —
// apply immediately, with no 2.5s latency.
let firstDefaultPending = true;

/** Test-only: restore the first-load delay so timing assertions are deterministic. */
export function resetSalesDefaultForTests(): void {
  firstDefaultPending = true;
}

/**
 * Applies the signed-in sales default one frame after mount. On the first load of
 * the session it waits {@link SALES_DEFAULT_DELAY_MS} so the empty "Pick a sale"
 * state is visible first; on every later application (e.g. a pinned-pane
 * conversation switch) it applies immediately.
 */
export function scheduleSalesDefault(
  apply: () => void,
  delayMs = SALES_DEFAULT_DELAY_MS,
): () => void {
  const effectiveDelay = firstDefaultPending ? delayMs : 0;
  firstDefaultPending = false;
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const rafId = requestAnimationFrame(() => {
    if (cancelled) return;
    timeoutId = window.setTimeout(() => {
      if (!cancelled) apply();
    }, effectiveDelay);
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  };
}
