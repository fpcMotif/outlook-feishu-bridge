/* eslint-disable max-lines-per-function */
import { useState } from "react";

import { ConnectCard } from "./ConnectCard";
import { ReceivedScreen } from "./ReceivedScreen";
import { REQUESTS, RequestCards } from "./RequestCards";
import { SubmitDock } from "./SubmitDock";

function Hero() {
  return (
    <header className="px-1 pt-3 pb-5">
      <div className="text-muted-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
        <span className="bg-muted-foreground inline-block h-px w-3.5" />
        New request
      </div>
      <h1 className="font-serif text-[34px] leading-[0.98] tracking-tight">
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
    <div className="flex min-h-0 flex-1 flex-col px-5">
      <div className="flex flex-1 flex-col justify-center py-8">
        <header className="px-1 pb-5">
          <div className="text-muted-foreground mb-3 flex items-center gap-2 text-[11px] font-semibold tracking-[0.14em] uppercase">
            <span className="bg-muted-foreground inline-block h-px w-3.5" />
            Account required
          </div>
          <h1 className="font-serif text-[34px] leading-[0.98] tracking-tight">
            Connect Feishu
            <br />
            to continue
          </h1>
          <p className="text-foreground/70 mt-2 max-w-[32ch] text-sm leading-relaxed">
            Log in before choosing request cards so the email can be routed from your account.
          </p>
        </header>
        <ConnectCard onLogin={onLogin} onLoginFallback={onLoginFallback} />
      </div>
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
  const [screen, setScreen] = useState<"build" | "received">("build");
  const [sending, setSending] = useState(false);

  const filledCount = REQUESTS.filter((r) => (notes[r.id] ?? "").trim() !== "").length;

  const handleSubmit = () => {
    if (filledCount === 0 || sending) return;
    setSending(true);
    window.setTimeout(() => {
      setSending(false);
      setScreen("received");
    }, 900);
  };

  if (screen === "received") {
    return <ReceivedScreen channelCount={filledCount} onForwardAnother={() => setScreen("build")} />;
  }

  if (!isLoggedIn) {
    return <LoginScreen onLogin={onLogin} onLoginFallback={onLoginFallback} />;
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
        sending={sending}
        hint="Start a request above"
        onSubmit={handleSubmit}
      />
    </>
  );
}
