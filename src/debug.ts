// On-screen debug capture for hard-to-reach environments (e.g. the Outlook
// taskpane on a China network, where opening DevTools isn't practical). Buffers
// app events + uncaught errors so DebugPanel can render them.

export interface DebugEntry {
  id: number;
  time: string;
  level: "log" | "warn" | "error";
  msg: string;
}

const entries: DebugEntry[] = [];
const MAX = 300;
let nextId = 0;
const listeners = new Set<() => void>();

function emit(level: DebugEntry["level"], msg: string): void {
  entries.push({
    id: nextId++,
    time: new Date().toISOString().slice(11, 23),
    level,
    msg,
  });
  if (entries.length > MAX) entries.shift();
  for (const fn of listeners) fn();
}

export function dlog(msg: string): void {
  emit("log", msg);
}

// Profiling helper for load and sync work. Pass a performance.now() start; logs
// elapsed ms with a stopwatch prefix so the per-segment breakdown is readable
// straight off the DebugPanel. Returns the elapsed ms.
export function dtime(label: string, startMs: number): number {
  const elapsed = performance.now() - startMs;
  emit("log", `⏱ ${label}: ${Math.round(elapsed)}ms`);
  return elapsed;
}

// Load-cycle stopwatch. performance.now() is ms since the taskpane document
// started loading — i.e. roughly since the add-in icon was clicked (Outlook
// navigates the pane to our URL then). Use this to profile boot → Office.js
// init → mail readable, the phase BEFORE Bitable Sync.
export function dload(label: string): void {
  emit("log", `⏱ ${label}: ${Math.round(performance.now())}ms since pane load`);
}

export function getDebugEntries(): DebugEntry[] {
  return entries;
}

export function subscribeDebug(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

// Format one console arg for the buffer. Module-scope: captures nothing, so it
// is shared rather than re-allocated per initDebug call.
function fmt(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

// Wrap one console method so its calls also land in the buffer (DevTools isn't
// reachable in the Outlook pane) and reach Sentry via the breadcrumb subscription.
function wrapConsole(
  method: "log" | "info" | "debug" | "warn" | "error",
  level: DebugEntry["level"],
): void {
  const orig = (console[method] as (...a: unknown[]) => void).bind(console);
  console[method] = ((...args: unknown[]) => {
    emit(level, args.map((a) => fmt(a)).join(" ").slice(0, 1000));
    orig(...args);
  }) as Console[typeof method];
}

let installed = false;

export function initDebug(): void {
  if (installed) return;
  installed = true;

  window.addEventListener("error", (e) => {
    emit("error", `window.onerror: ${e.message} (${e.filename}:${e.lineno})`);
  });
  window.addEventListener("unhandledrejection", (e) => {
    emit("error", `unhandledrejection: ${String(e.reason)}`);
  });
  // Capture CSP blocks — e.g. a pdfmake/web-worker or blob: URL the add-in's
  // Content-Security-Policy refuses, which would otherwise fail silently.
  window.addEventListener("securitypolicyviolation", (e) => {
    emit("error", `CSP blocked ${e.violatedDirective}: ${e.blockedURI || "(inline)"}`);
  });

  // Mirror the real browser (F12) console into the buffer — you can't open
  // devtools inside the Outlook pane, so this is how the add-in's behavior
  // (Feishu login handshake, Office.js, Convex) becomes visible on the
  // DebugPanel. Sentry gets these too via the breadcrumb subscription.
  wrapConsole("log", "log");
  wrapConsole("info", "log");
  wrapConsole("debug", "log");
  wrapConsole("warn", "warn");
  wrapConsole("error", "error");

  emit("log", `boot ${location.href}`);
  dload("boot (HTML+JS loaded, app start)");
}
