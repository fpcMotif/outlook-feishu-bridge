/* eslint-disable max-lines-per-function */
import { useState } from "react";

import { CoworkerPicker } from "./CoworkerPicker";
import { ConnectCard } from "./ConnectCard";
import { ReceivedScreen } from "./ReceivedScreen";
import { REQUESTS, RequestCards } from "./RequestCards";
import { SubmitDock } from "./SubmitDock";

function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
        <span className="bg-muted-foreground inline-block h-px w-3.5" />
        New request
      </div>
      <h1 className="font-serif text-[34px] leading-[0.98]">
        How can we
        <br />
        help today?
      </h1>
      <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
        Pick a track. We&apos;ll route it to the right team in seconds.
      </p>
    </header>
  );
}

function LoginScreen({
  onLogin,
  onLoginFallback,
}: {
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  return (
    <div className="screen-flow no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-8 pb-6">
      <header className="px-1">
        <div className="text-accent-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
          <span className="bg-muted-foreground inline-block h-px w-3.5" />
          Outlook handoff
        </div>
        <h1 className="font-serif text-[34px] leading-[0.98]">
          Sign in before
          <br />
          routing the email
        </h1>
        <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
          Keep account connection separate from the request cards, then continue cleanly.
        </p>
      </header>
      <ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />
    </div>
  );
}

export function ForwardScreen({
  isLoggedIn,
  onLogin,
  onLoginFallback,
}: {
  isLoggedIn: boolean;
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [screen, setScreen] = useState<"build" | "contacts" | "received">("build");
  const [sending, setSending] = useState(false);
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);

  const filledRequests = REQUESTS.flatMap((r) => {
    const note = (notes[r.id] ?? "").trim();
    return note ? [{ id: r.id, title: r.title, note }] : [];
  });
  const filledCount = filledRequests.length;
  const selectedCount = selectedContacts.length;

  const toggleContact = (openId: string) => {
    setSelectedContacts((current) =>
      current.includes(openId)
        ? current.filter((id) => id !== openId)
        : [...current, openId],
    );
  };

  const handleSubmit = () => {
    if (sending) return;
    if (screen === "build") {
      if (filledCount === 0) return;
      setScreen("contacts");
      return;
    }
    if (selectedCount === 0) return;
    setSending(true);
    window.setTimeout(() => {
      setSending(false);
      setScreen("received");
    }, 900);
  };

  if (screen === "received") {
    return <ReceivedScreen channelCount={selectedCount} onForwardAnother={() => setScreen("build")} />;
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
  }

  if (screen === "contacts") {
    return (
      <>
        <CoworkerPicker
          requests={filledRequests}
          selectedOpenIds={selectedContacts}
          onToggle={toggleContact}
          onBack={() => setScreen("build")}
        />
        <SubmitDock
          count={selectedCount}
          canSubmit={selectedCount > 0}
          sending={sending}
          hint="Choose a Feishu coworker"
          label={
            selectedCount > 0
              ? `Submit to ${selectedCount} coworker${selectedCount > 1 ? "s" : ""}`
              : undefined
          }
          onSubmit={handleSubmit}
        />
      </>
    );
  }

  return (
    <>
      <div className="screen-flow no-scrollbar flex-1 overflow-y-auto px-5 pt-1 pb-2">
        <Hero />
        <div className="space-y-3">
          <RequestCards
            values={notes}
            onChange={(id, value) => setNotes((n) => ({ ...n, [id]: value }))}
          />
        </div>
      </div>

      <SubmitDock
        count={filledCount}
        canSubmit={filledCount > 0}
        sending={sending}
        hint="Start a request above"
        label={filledCount > 0 ? "Continue" : undefined}
        onSubmit={handleSubmit}
      />
    </>
  );
}
