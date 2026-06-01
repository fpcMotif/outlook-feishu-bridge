/* eslint-disable max-lines-per-function -- textarea auto-resize effect + email field markup */
import * as React from "react";
import { AtSign } from "lucide-react";

import { MIN_EMAIL_FIELD_HEIGHT } from "./constants";

export function ClientInfo({
  clientEmail,
  onClientEmailChange,
}: {
  clientEmail: string;
  onClientEmailChange: (email: string) => void;
}) {
  const emailRef = React.useRef<HTMLTextAreaElement>(null);

  React.useLayoutEffect(() => {
    const email = emailRef.current;
    if (!email) return;

    const resizeEmail = () => {
      email.style.height = "0px";
      email.style.height = `${Math.max(MIN_EMAIL_FIELD_HEIGHT, email.scrollHeight)}px`;
    };

    resizeEmail();
    window.addEventListener("resize", resizeEmail);

    const observer =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(resizeEmail);
    observer?.observe(email.parentElement ?? email);

    return () => {
      window.removeEventListener("resize", resizeEmail);
      observer?.disconnect();
    };
  }, [clientEmail]);

  return (
    <div className="flex min-h-14 min-w-0 items-center gap-3 px-3 py-2" data-client-row="true">
      <span
        className="text-muted-foreground flex size-8 shrink-0 items-center justify-center"
        aria-hidden="true"
      >
        <AtSign className="size-4" />
      </span>
      <textarea
        ref={emailRef}
        aria-label="Email"
        inputMode="email"
        autoCapitalize="none"
        autoComplete="email"
        value={clientEmail}
        onChange={(e) => onClientEmailChange(e.target.value.replaceAll(/\s+/g, ""))}
        placeholder="email@example.com"
        rows={1}
        spellCheck={false}
        className="placeholder:text-muted-foreground min-h-8 min-w-0 flex-1 resize-none overflow-hidden bg-transparent py-2 text-xs leading-4 font-semibold outline-none [overflow-wrap:anywhere] [word-break:break-word]"
      />
    </div>
  );
}
