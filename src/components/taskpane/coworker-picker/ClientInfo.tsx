import * as React from "react";

export function ClientInfo({
  clientEmail,
  onClientEmailChange,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
}) {
  return (
    <section className="bg-card-soft rounded-xl px-3 py-2 shadow-[var(--shadow-border)]">
      <div className="flex min-w-0 items-center gap-2">
        <span className="text-muted-foreground shrink-0 text-[11px] font-semibold uppercase">
          Client email
        </span>
        <span className="bg-border h-3 w-px shrink-0" />
        <input
          aria-label="Client email"
          type="email"
          value={clientEmail}
          onChange={(e) => onClientEmailChange(e.target.value)}
          placeholder="client@example.com"
          className="placeholder:text-muted-foreground min-h-10 min-w-0 flex-1 bg-transparent text-xs font-semibold outline-none"
        />
      </div>
    </section>
  );
}
