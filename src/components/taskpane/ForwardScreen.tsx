/* eslint-disable max-lines-per-function */
import { useCallback, useEffect, useState } from "react";

import { CoworkerPicker } from "./CoworkerPicker";
import { ConnectCard } from "./ConnectCard";
import { ReceivedScreen } from "./ReceivedScreen";
import { REQUESTS, RequestCards } from "./RequestCards";
import { SubmitDock } from "./SubmitDock";
import { SyncScreen } from "./SyncScreen";

function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <div className="text-accent-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold uppercase">
        <span className="bg-muted-foreground inline-block h-px w-3.5" />
        New request
      </div>
      <h1 className="font-serif text-[34px] leading-[0.98] tracking-tight">
        How can we
        <br />
        help today?
      </h1>
      <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
        Route it to the right coworker in seconds.
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
    <div className="no-scrollbar flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-5 pt-8 pb-6">
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
  clientEmail,
  onLogin,
  onLoginFallback,
}: {
  isLoggedIn: boolean;
  clientEmail: string;
  onLogin: () => void;
  onLoginFallback: () => void;
}) {
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [confirmedClientEmail, setConfirmedClientEmail] = useState(clientEmail);
  const [screen, setScreen] = useState<"build" | "contacts" | "sync" | "received">("build");
  const [selectedContacts, setSelectedContacts] = useState<string[]>([]);

  useEffect(() => {
    setConfirmedClientEmail(clientEmail);
  }, [clientEmail]);

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
    if (screen === "build") {
      if (filledCount === 0) return;
      setScreen("contacts");
      return;
    }
    if (selectedCount === 0) return;
    setScreen("sync");
  };

  const finishSync = useCallback(() => setScreen("received"), []);

  if (screen === "received") {
    return <ReceivedScreen channelCount={selectedCount} onForwardAnother={() => setScreen("build")} />;
  }

  if (screen === "sync") {
    return (
      <SyncScreen
        requests={filledRequests}
        clientEmail={confirmedClientEmail}
        channelCount={selectedCount}
        onComplete={finishSync}
      />
    );
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
  }

  if (screen === "contacts") {
    return (
      <>
        <CoworkerPicker
          clientEmail={confirmedClientEmail}
          onClientEmailChange={setConfirmedClientEmail}
          selectedOpenIds={selectedContacts}
          onToggle={toggleContact}
          onBack={() => setScreen("build")}
        />
        <SubmitDock
          count={selectedCount}
          canSubmit={selectedCount > 0}
          sending={false}
          hint="Choose a Feishu coworker"
          label={
            selectedCount > 0
              ? `Submit to ${selectedCount} coworker${selectedCount > 1 ? "s" : ""}`
              : undefined
          }
          footer={`${filledCount} request${filledCount > 1 ? "s" : ""} ready for Bitable + Convex sync`}
          onSubmit={handleSubmit}
        />
      </>
    );
  }

  return (
    <>
      <div className="no-scrollbar flex-1 overflow-y-auto px-5 pt-1 pb-2">
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
        sending={false}
        hint="Start a request above"
        label={filledCount > 0 ? "Continue" : undefined}
        footer="Request Types & Details"
        onSubmit={handleSubmit}
      />
    </>
  );
}
