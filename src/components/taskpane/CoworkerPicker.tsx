/* eslint-disable max-lines-per-function */
import { useMemo, useState } from "react";
import { ArrowLeft, Check, Database, Search, UserRound, X } from "lucide-react";

import type { Contact } from "@/forward/targets";

interface FilledRequest {
  id: string;
  title: string;
  note: string;
}

// Prototype directory. Swap this filter for the real Feishu searchContacts
// action (GET /search/v1/user) once a live session token is available.
export const PREVIEW_COWORKERS: Contact[] = [
  { openId: "ou_jenny", name: "Jenny Xu" },
  { openId: "ou_michael", name: "Michael Chen" },
  { openId: "ou_sales_ops", name: "Sales Ops" },
  { openId: "ou_wei", name: "Wei Liang" },
  { openId: "ou_maria", name: "Maria Hoffmann" },
  { openId: "ou_carlos", name: "Carlos Mendez" },
  { openId: "ou_aiko", name: "Aiko Tanaka" },
  { openId: "ou_lena", name: "Lena Fischer" },
];

const RECENTS_KEY = "feishu_recent_coworkers";

function loadRecents(): Contact[] {
  try {
    const raw = localStorage.getItem(RECENTS_KEY);
    return raw ? (JSON.parse(raw) as Contact[]) : [];
  } catch {
    return [];
  }
}

export function CoworkerPicker({
  requests,
  selectedOpenIds,
  onToggle,
  onBack,
}: {
  requests: FilledRequest[];
  selectedOpenIds: string[];
  onToggle: (openId: string) => void;
  onBack: () => void;
}) {
  const [query, setQuery] = useState("");
  const [focused, setFocused] = useState(false);
  const [recents, setRecents] = useState<Contact[]>(loadRecents);

  const q = query.trim().toLowerCase();
  const directoryById = useMemo(() => {
    const map = new Map<string, Contact>();
    for (const c of [...PREVIEW_COWORKERS, ...recents]) map.set(c.openId, c);
    return map;
  }, [recents]);

  const results = useMemo(
    () => (q ? PREVIEW_COWORKERS.filter((c) => c.name.toLowerCase().includes(q)) : []),
    [q],
  );

  const searching = q.length > 0;
  const list = searching ? results : recents.length > 0 ? recents : PREVIEW_COWORKERS.slice(0, 4);
  const listLabel = searching ? "Results" : recents.length > 0 ? "Recent" : "Suggested";
  const selectedContacts = selectedOpenIds.flatMap((id) => {
    const contact = directoryById.get(id);
    return contact ? [contact] : [];
  });

  const handleToggle = (openId: string) => {
    const contact = directoryById.get(openId);
    if (contact) {
      const next = [contact, ...loadRecents().filter((c) => c.openId !== openId)].slice(0, 6);
      try {
        localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
      } catch {
        /* ignore quota / unavailable storage */
      }
      setRecents(next);
    }
    onToggle(openId);
  };

  return (
    <div className="screen-flow no-scrollbar flex-1 overflow-y-auto px-5 pt-3 pb-2">
      <button
        type="button"
        onClick={onBack}
        className="text-muted-foreground hover:text-foreground mb-4 inline-flex items-center gap-2 text-xs font-semibold"
      >
        <ArrowLeft className="size-4" />
        Back
      </button>
      <header className="px-1 pb-4">
        <div className="text-muted-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Forward to
        </div>
        <h1 className="font-serif text-[34px] leading-[0.98]">
          Select Feishu
          <br />
          coworkers
        </h1>
        <p className="text-foreground/70 mt-2 max-w-[34ch] text-sm leading-relaxed">
          Pick the people who should receive this request.
        </p>
      </header>

      <RequestSummary requests={requests} />

      <div
        className={
          "bg-card mt-4 flex items-center gap-2 rounded-[14px] border px-3 shadow-sm transition-shadow " +
          (focused ? "border-ring ring-ring/10 ring-[3px]" : "")
        }
      >
        <Search className="text-muted-foreground size-4 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder="Search Feishu coworkers…"
          className="placeholder:text-muted-foreground h-11 w-full bg-transparent text-sm outline-none"
        />
        {query ? (
          <button
            type="button"
            onClick={() => setQuery("")}
            aria-label="Clear search"
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        ) : null}
      </div>

      {selectedOpenIds.length > 0 ? (
        <div className="mt-2.5 flex flex-wrap gap-1.5">
          {selectedOpenIds.map((id) => (
            <span
              key={id}
              className="bg-secondary text-secondary-foreground inline-flex items-center gap-1 rounded-full py-1 pr-1 pl-2.5 text-xs font-medium"
            >
              {directoryById.get(id)?.name ?? "Coworker"}
              <button
                type="button"
                onClick={() => handleToggle(id)}
                aria-label="Remove coworker"
                className="hover:text-foreground inline-flex"
              >
                <X className="size-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}

      {selectedContacts.length > 0 ? (
        <BitableSyncPreview requests={requests} contacts={selectedContacts} />
      ) : null}

      <div className="text-muted-foreground mt-4 mb-2 px-1 text-[11px] font-semibold tracking-wide uppercase">
        {listLabel}
      </div>
      <div className="space-y-2">
        {list.length > 0 ? (
          list.map((contact) => (
            <CoworkerOption
              key={contact.openId}
              contact={contact}
              selected={selectedOpenIds.includes(contact.openId)}
              onToggle={handleToggle}
            />
          ))
        ) : (
          <p className="text-muted-foreground px-1 py-2 text-sm">No coworkers match “{query}”.</p>
        )}
      </div>
    </div>
  );
}

function BitableSyncPreview({
  requests,
  contacts,
}: {
  requests: FilledRequest[];
  contacts: Contact[];
}) {
  const rowCount = requests.length * contacts.length;
  const recipients = contacts.map((contact) => contact.name).join(", ");
  return (
    <section className="sync-preview mt-3 rounded-[18px] border bg-card p-3 shadow-sm">
      <div className="text-muted-foreground flex items-center justify-between gap-3 text-[11px] font-semibold uppercase">
        <span className="inline-flex items-center gap-1.5">
          <Database className="size-3.5" />
          Bitable preview
        </span>
        <span>{rowCount} row{rowCount === 1 ? "" : "s"}</span>
      </div>
      <div className="mt-3 grid grid-cols-[4.5rem_1fr] gap-x-3 gap-y-2 text-xs">
        <span className="text-muted-foreground">Recipient</span>
        <span className="font-medium">{recipients}</span>
        {requests.map((request) => (
          <BitablePreviewRow key={request.id} request={request} />
        ))}
      </div>
    </section>
  );
}

function BitablePreviewRow({ request }: { request: FilledRequest }) {
  return (
    <>
      <span className="text-muted-foreground">Type</span>
      <span className="font-medium">{request.title}</span>
      <span className="text-muted-foreground">Note</span>
      <span className="text-foreground/80 line-clamp-2">{request.note}</span>
    </>
  );
}

function RequestSummary({ requests }: { requests: FilledRequest[] }) {
  return (
    <section className="bg-card-soft rounded-[18px] border p-3">
      <div className="text-muted-foreground text-[11px] font-semibold uppercase">Ready</div>
      <div className="mt-2 space-y-2">
        {requests.map((request) => (
          <div key={request.id} className="bg-card rounded-xl border px-3 py-2">
            <div className="text-sm font-semibold">{request.title}</div>
            <p className="text-muted-foreground mt-0.5 line-clamp-2 text-xs">{request.note}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CoworkerOption({
  contact,
  selected,
  onToggle,
}: {
  contact: Contact;
  selected: boolean;
  onToggle: (openId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onToggle(contact.openId)}
      className="bg-card flex w-full items-center gap-3 rounded-[18px] border px-4 py-3 text-left shadow-sm transition data-[pressed=true]:bg-secondary"
      data-pressed={selected}
    >
      <span className="bg-secondary text-muted-foreground flex size-10 items-center justify-center rounded-full">
        <UserRound className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{contact.name}</span>
        <span className="text-muted-foreground block truncate text-xs">Feishu coworker</span>
      </span>
      {selected ? <Check className="text-foreground size-5" /> : null}
    </button>
  );
}
