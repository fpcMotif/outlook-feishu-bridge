import { useEffect, useRef, useState } from "react";

import { dload } from "../debug";
import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem } from "../office/useMailItem";
import { EmptyState } from "./taskpane/EmptyState";
import { RequestIntakeScreen } from "./taskpane/RequestIntakeScreen";
import { PaneHeader } from "./taskpane/PaneHeader";
import { DEV_SAMPLE } from "./taskpane/devSample";

function useDevPreview(host: string | null) {
  const [devLoggedIn, setDevLoggedIn] = useState(false);
  const devPreview = import.meta.env.DEV && host !== "Outlook";
  const showDevUser =
    devPreview && (devLoggedIn || new URLSearchParams(window.location.search).has("devUser"));
  const devUser = showDevUser
    ? { openId: "ou_dev", userName: "Jenny Xu", email: "jenny.xu@fenchem.com", org: "Branch Sales" }
    : null;

  return { devPreview, devUser, devLoggedIn, setDevLoggedIn };
}

function useBootTracker(host: string | null, isLoading: boolean, isLoggedIn: boolean) {
  // ADR-0016: the user-visible boot phase ends here — "Feishu SPA ready" is
  // the first paint where Office.js has settled AND the Feishu auth check
  // resolved (logged-in or logged-out, but no longer "loading"). This is the
  // "I clicked the icon → I can interact" interval. Logged once per pane.
  const bootMarked = useRef(false);
  useEffect(() => {
    if (bootMarked.current) return;
    const officeSettled = host !== null;
    const authSettled = !isLoading;
    if (officeSettled && authSettled) {
      bootMarked.current = true;
      dload(`Feishu SPA ready (host=${host}, loggedIn=${isLoggedIn})`);
    }
  }, [host, isLoading, isLoggedIn]);
}

export function TaskPane({ host }: { host: string | null }) {
  const { mailItem, loading, error, readCurrentItem } = useMailItem(Boolean(host && host !== "browser"));
  const feishuAuth = useFeishuAuth();

  useBootTracker(host, feishuAuth.isLoading, feishuAuth.isLoggedIn);
  const { devPreview, devUser, setDevLoggedIn } = useDevPreview(host);

  const item = mailItem ?? (devPreview ? DEV_SAMPLE : null);

  const isLoggedIn = feishuAuth.isLoggedIn || devUser !== null;
  const user = feishuAuth.user ?? devUser;

  const handleLogin = devPreview ? () => setDevLoggedIn(true) : feishuAuth.login;
  const handleLoginFallback = devPreview ? () => setDevLoggedIn(true) : feishuAuth.loginFallback;
  const handleLogout = devPreview ? () => setDevLoggedIn(false) : feishuAuth.logout;

  return (
    <div className="bg-background flex h-screen w-full flex-col overflow-hidden">
      {isLoggedIn && user ? <PaneHeader user={user} onLogout={handleLogout} /> : null}
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
