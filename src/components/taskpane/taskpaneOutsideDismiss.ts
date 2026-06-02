import { useEffect, type RefObject } from "react";

/** Dismiss on document mousedown outside `boundaryRef`. */
export function useOutsidePointerDismiss(
  boundaryRef: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  enabled: boolean,
) {
  useEffect(() => {
    if (!enabled) return;
    const dismiss = onDismiss;
    function onPointer(event: MouseEvent) {
      if (boundaryRef.current && !boundaryRef.current.contains(event.target as Node)) {
        dismiss();
      }
    }
    document.addEventListener("mousedown", onPointer);
    return () => document.removeEventListener("mousedown", onPointer);
  }, [boundaryRef, onDismiss, enabled]);
}
