import { useState, useEffect } from 'react';
import { dlog, dload } from '../debug';

interface OfficeState {
  isReady: boolean;
  host: string | null;
  error: string | null;
}

export function useOffice(): OfficeState {
  const [state, setState] = useState<OfficeState>({
    isReady: false,
    host: null,
    error: null,
  });

  useEffect(() => {
    // Office.onReady can take ~3s+ to fire on the new Outlook web (OfficeOnline).
    // In production we wait for it for as long as it takes (the loading spinner
    // shows meanwhile) so we never flash a wrong "browser / no mailbox" state and
    // then correct ourselves. The timed fallback is ONLY for local browser dev,
    // where there is no Office host to hand-shake with and onReady never fires.
    let fallback: ReturnType<typeof setTimeout> | undefined;
    if (import.meta.env.DEV) {
      fallback = setTimeout(() => {
        dlog('DEV: Office.onReady did not fire in 3s -> browser fallback (no mailbox)');
        setState((s) => (s.isReady ? s : { isReady: true, host: 'browser', error: null }));
      }, 3000);
    }

    Office.onReady((info) => {
      if (fallback) clearTimeout(fallback);
      const host = info.host?.toString() ?? null;
      dlog(`Office.onReady fired: host=${host} platform=${info.platform?.toString() ?? '?'}`);
      // The big slice of "icon click -> usable": Office.js loads + handshakes
      // with the host (~5s on new Outlook web). Mostly outside our control.
      dload("Office.js ready (handshake done)");
      setState({ isReady: true, host, error: null });
    });

    return () => {
      if (fallback) clearTimeout(fallback);
    };
  }, []);

  return state;
}
