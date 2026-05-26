/* eslint-disable max-lines-per-function */
import { useEffect, useState } from "react";
import { Loader2, MailOpen } from "lucide-react";

import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem, type MailItemData } from "../office/useMailItem";
import { Button } from "./ui/button";
import { ForwardScreen } from "./taskpane/ForwardScreen";
import { PaneHeader } from "./taskpane/PaneHeader";

// Browser dev has no Office host or mailbox (useOffice falls back to host
// "browser" after 3s). A sample item lets the full drawer flow render for
// preview; ForwardScreen simulates the submit so nothing is actually sent.
const DEV_SAMPLE: MailItemData = {
  subject: "Inquiry — bulk pricing for L-Carnitine 500kg quarterly",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: ["procurement@bayerpharma.de"],
  body: "Hi Jenny, we are preparing the 2026 procurement plan and would like quarterly bulk pricing for L-Carnitine USP, ≥99%. Volume ~2,500 kg/year (Q1–Q4 2026). Please also share COA and lead times to Hamburg port. We'd like to lock a contract by end of next week.",
  dateTimeCreated: new Date(),
  internetMessageId: "<dev-sample@fenchem.com>",
  itemId: "dev-sample",
  conversationId: "dev-sample",
  userEmail: "jenny.xu@fenchem.com",
  attachments: [
    { id: "a1", name: "RFQ-2026-Q1.pdf", contentType: "application/pdf", size: 184320, isInline: false },
  ],
};

function EmptyState({
  loading,
  error,
  onRead,
}: {
  loading: boolean;
  error: string | null;
  onRead: () => void;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center px-8 text-center">
      <span className="bg-secondary text-muted-foreground mb-4 flex size-14 items-center justify-center rounded-2xl">
        {loading ? <Loader2 className="size-6 animate-spin" /> : <MailOpen className="size-6" />}
      </span>
      <h2 className="font-serif text-2xl">{loading ? "Reading your email…" : "No message open"}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-[32ch] text-sm leading-relaxed">
        {error ?? "Open a received message in Outlook, then forward it to Feishu from here."}
      </p>
      {loading ? null : (
        <Button variant="secondary" className="mt-4" onClick={onRead}>
          Read current email
        </Button>
      )}
    </div>
  );
}

export function TaskPane({ host }: { host: string | null }) {
  const { mailItem, loading, error, readCurrentItem } = useMailItem();
  const feishuAuth = useFeishuAuth();
  const [devLoggedIn, setDevLoggedIn] = useState(false);

  // Auto-load the current email inside Outlook so there's no extra click on open.
  useEffect(() => {
    if (host && host !== "browser") void readCurrentItem();
  }, [host, readCurrentItem]);

  // Real Outlook sets host "Outlook"; anything else in dev (host null or
  // "browser") means no mailbox, so preview a sample item and simulate submit.
  const devPreview = import.meta.env.DEV && host !== "Outlook";
  const item = mailItem ?? (devPreview ? DEV_SAMPLE : null);

  // Dev-only: clicking "Log in" advances straight to the logged-in UI (profile +
  // coworker picker) without the real OAuth popup. ?devUser=1 starts logged in.
  const showDevUser =
    devPreview && (devLoggedIn || new URLSearchParams(window.location.search).has("devUser"));
  const devUser = showDevUser
    ? { openId: "ou_dev", userName: "Jenny Xu", email: "jenny.xu@fenchem.com", org: "Branch Sales" }
    : null;
  const isLoggedIn = feishuAuth.isLoggedIn || devUser !== null;
  const user = feishuAuth.user ?? devUser;
  const handleLogin = devPreview ? () => setDevLoggedIn(true) : feishuAuth.login;
  const handleLoginFallback = devPreview ? () => setDevLoggedIn(true) : feishuAuth.loginFallback;
  const handleLogout = devPreview ? () => setDevLoggedIn(false) : feishuAuth.logout;

  return (
    <div className="bg-background flex min-h-screen justify-center">
      <div className="flex h-screen w-full max-w-[460px] flex-col overflow-hidden">
        <PaneHeader
          isLoggedIn={isLoggedIn}
          user={user}
          onLogin={handleLogin}
          onLogout={handleLogout}
        />
        <main className="flex min-h-0 flex-1 flex-col">
          {item ? (
            <ForwardScreen
              isLoggedIn={isLoggedIn}
              onLogin={handleLogin}
              onLoginFallback={handleLoginFallback}
            />
          ) : (
            <EmptyState loading={loading} error={error} onRead={readCurrentItem} />
          )}
        </main>
      </div>
    </div>
  );
}
