/** Brief pause after paint so the empty sales prompt reads before self-default. */
export const SALES_DEFAULT_DELAY_MS = 2500;

/**
 * Applies the signed-in sales default one frame after mount, then after a short
 * delay so the empty "Pick a sales" state is visible first.
 */
export function scheduleSalesDefault(
  apply: () => void,
  delayMs = SALES_DEFAULT_DELAY_MS,
): () => void {
  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const rafId = requestAnimationFrame(() => {
    if (cancelled) return;
    timeoutId = window.setTimeout(() => {
      if (!cancelled) apply();
    }, delayMs);
  });
  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  };
}
