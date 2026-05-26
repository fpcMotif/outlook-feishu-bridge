import { useEffect, useState, type CSSProperties } from "react";
import { getDebugEntries, subscribeDebug, type DebugEntry } from "../debug";

// Bump on each deploy so you can confirm the taskpane loaded the fresh bundle.
const BUILD_TAG = "dbg-2";

interface OfficeInfo {
  isReady: boolean;
  host: string | null;
  error: string | null;
}

const PANEL: CSSProperties = {
  position: "fixed",
  left: 0,
  right: 0,
  bottom: 0,
  zIndex: 99999,
  fontFamily: "monospace",
  fontSize: "11px",
  background: "#101010",
  color: "#3f3",
  borderTop: "2px solid #3f3",
  overflow: "auto",
};
const HEADER: CSSProperties = {
  position: "sticky",
  top: 0,
  display: "flex",
  justifyContent: "space-between",
  gap: "6px",
  padding: "2px 6px",
  background: "#000",
};
const BTN: CSSProperties = {
  color: "#3f3",
  background: "transparent",
  border: "1px solid #3f3",
  cursor: "pointer",
};

function officeFacts(): string {
  const hasOffice = typeof Office !== "undefined";
  const mailbox = hasOffice && Boolean(Office.context?.mailbox);
  const item = hasOffice && Boolean(Office.context?.mailbox?.item);
  return `Office=${hasOffice} mailbox=${mailbox} item=${item}`;
}

function convexConn(): string {
  const client = (
    window as unknown as {
      __convex?: {
        connectionState?: () => { isWebSocketConnected?: boolean; hasInflightRequests?: boolean };
      };
    }
  ).__convex;
  try {
    const cs = client?.connectionState?.();
    return cs ? `ws=${String(cs.isWebSocketConnected)} inflight=${String(cs.hasInflightRequests)}` : "n/a";
  } catch {
    return "err";
  }
}

function levelColor(level: DebugEntry["level"]): string {
  if (level === "error") return "#f66";
  if (level === "warn") return "#fd5";
  return "#3f3";
}

function DebugBody({ office, entries }: { office: OfficeInfo; entries: DebugEntry[] }) {
  return (
    <div style={{ padding: "2px 6px" }}>
      <div>url {location.href}</div>
      <div>convexUrl {String(import.meta.env.VITE_CONVEX_URL)}</div>
      <div>siteUrl {String(import.meta.env.VITE_CONVEX_SITE_URL)}</div>
      <div>feishuAppId {String(import.meta.env.VITE_FEISHU_APP_ID)}</div>
      {office.error ? <div style={{ color: "#f66" }}>office.error {office.error}</div> : null}
      <hr style={{ borderColor: "#333" }} />
      {entries.map((e) => (
        <div key={e.id} style={{ color: levelColor(e.level), whiteSpace: "pre-wrap" }}>
          {e.time} {e.level === "log" ? "" : `[${e.level}] `}
          {e.msg}
        </div>
      ))}
    </div>
  );
}

export function DebugPanel({ office }: { office: OfficeInfo }) {
  const [, setTick] = useState(0);
  const [open, setOpen] = useState(true);
  const [conn, setConn] = useState("?");

  useEffect(() => subscribeDebug(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    const id = setInterval(() => setConn(convexConn()), 1000);
    return () => clearInterval(id);
  }, []);

  return (
    <div style={{ ...PANEL, maxHeight: open ? "45vh" : "1.7em" }}>
      <div style={HEADER}>
        <span>
          DBG {BUILD_TAG} host={office.host ?? "?"} ready={String(office.isReady)} {officeFacts()} convex[{conn}]
        </span>
        <button type="button" onClick={() => setOpen((o) => !o)} style={BTN}>
          {open ? "hide" : "show"}
        </button>
      </div>
      {open ? <DebugBody office={office} entries={getDebugEntries()} /> : null}
    </div>
  );
}
