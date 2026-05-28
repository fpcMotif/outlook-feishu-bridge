/* eslint-disable max-lines-per-function */
import { useEffect, useRef, useState } from "react";
import { Loader2, MailOpen } from "lucide-react";

import { dload } from "../debug";
import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem, type MailItemData } from "../office/useMailItem";
import { Button } from "./ui/button";
import { RequestIntakeScreen } from "./taskpane/RequestIntakeScreen";
import { FeishuProfile } from "./taskpane/FeishuProfile";

// Browser dev has no Office host or mailbox (useOffice falls back to host
// "browser" after 3s). A sample item lets the full drawer flow render for
// preview; tests mock the Bitable Sync so nothing is actually written.
const DEV_SAMPLE: MailItemData = {
  subject: "Inquiry - bulk pricing for L-Carnitine 500kg quarterly",
  from: "m.hoffmann@bayerpharma.de",
  to: ["jenny.xu@fenchem.com"],
  cc: ["procurement@bayerpharma.de"],
  body: "Hi Jenny, we are preparing the 2026 procurement plan and would like quarterly bulk pricing for L-Carnitine USP, >=99%. Volume ~2,500 kg/year (Q1-Q4 2026). Please also share COA and lead times to Hamburg port. We'd like to lock a contract by end of next week.",
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
      <h2 className="font-serif text-2xl">{loading ? "Reading your email..." : "No message open"}</h2>
      <p className="text-muted-foreground mt-1.5 max-w-[32ch] text-sm leading-relaxed">
        {error ?? "Open a received message in Outlook, then sync it to Feishu from here."}
      </p>
      {loading ? null : (
        <Button variant="secondary" className="mt-4" onClick={onRead}>
          Read current email
        </Button>
      )}
    </div>
  );
}

// ADR-0016: the user-visible boot phase ends at the first paint where Office.js
// has settled and Feishu auth is no longer loading. This logs once per pane.
function BootReadyMilestone({ host, isLoggedIn }: { host: string; isLoggedIn: boolean }) {
  const marked = useRef(false);
  useEffect(() => {
    if (marked.current) return;
    marked.current = true;
    dload(`Feishu SPA ready (host=${host}, loggedIn=${isLoggedIn})`);
  }, [host, isLoggedIn]);
  return null;
}

export function TaskPane({ host }: { host: string | null }) {
  const { mailItem, loading, error, readCurrentItem } = useMailItem(Boolean(host && host !== "browser"));
  const feishuAuth = useFeishuAuth();
  const [devLoggedIn, setDevLoggedIn] = useState(false);

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
    <div className="bg-background relative flex h-screen w-full flex-col overflow-hidden">
      {host !== null && !feishuAuth.isLoading ? (
        <BootReadyMilestone host={host} isLoggedIn={feishuAuth.isLoggedIn} />
      ) : null}
      {isLoggedIn && user ? (
        <div className="absolute top-2 right-2 z-40">
          <FeishuProfile user={user} onLogout={handleLogout} />
        </div>
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col">
        {item ? (
          <RequestIntakeScreen
            isLoggedIn={isLoggedIn}
            mailItem={item}
            sessionId={feishuAuth.sessionId}
            user={user ?? undefined}
            userAccessToken={feishuAuth.userAccessToken}
            onLogin={handleLogin}
            onLoginFallback={handleLoginFallback}
          />
        ) : (
          <EmptyState loading={loading} error={error} onRead={readCurrentItem} />
        )}
      </main>
    </div>
  );
}
