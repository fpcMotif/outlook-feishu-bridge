/* eslint-disable max-lines-per-function */
import { useEffect, useRef, useState } from "react";
import { MailOpen } from "lucide-react";

import { dload } from "../debug";
import { useFeishuAuth } from "../hooks/useFeishuAuth";
import { useMailItem, type MailItemData } from "../office/useMailItem";
import { Button } from "./ui/button";
import { RequestIntakeScreen } from "./taskpane/RequestIntakeScreen";
import { FeishuProfile } from "./taskpane/FeishuProfile";
import { ThemeToggle } from "./ThemeToggle";
import { ReceivedScreen } from "./taskpane/ReceivedScreen";
import { SyncScreen } from "./taskpane/SyncScreen";
import { AuthResolvingScreen } from "./taskpane/AuthResolvingScreen";
import { LoginScreen } from "./taskpane/LoginScreen";
import {
  findDevEmailFixture,
  submittedAtForDevEmailFixture,
} from "../../convex/feishu/devEmailFixtures";
import { DEV_SYNC_PREVIEW } from "../testing/sync-preview-fixtures";
import {
  buildMockStagingDeps,
  buildMockUploadedFiles,
  isMockUploadsMode,
} from "../testing/mock-uploads-fixtures";

// Browser dev has no Office host or mailbox (useOffice falls back to host
// "browser" after 3s). A sample item lets the full drawer flow render for
// preview; tests mock the Base Sync so nothing is actually written.
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
  // The Self-Forward primary recipient is the signed-in user's own mailbox; in
  // dev preview that is fanpc@fenchem.com (the test user). jenny.xu is just
  // a fictional "to" recipient on the sample inbound email; never a sendable
  // address from this add-in.
  userEmail: "fanpc@fenchem.com",
  attachments: [
    { id: "a1", name: "RFQ-2026-Q1.pdf", attachmentType: "file", size: 184320, isInline: false },
  ],
};

function DevScreenPreview({
  screen,
  devFixtureKey,
}: {
  screen: "sync" | "received" | "login";
  devFixtureKey: string | null;
}) {
  if (screen === "login") {
    return (
      <AuthResolvingScreen
        onLogin={() => {}}
        onLoginFallback={() => {}}
      />
    );
  }

  if (screen === "sync") {
    return (
      <SyncScreen preview={DEV_SYNC_PREVIEW} />
    );
  }

  const fixture = findDevEmailFixture(devFixtureKey);

  return (
    <ReceivedScreen
      coworkerCount={fixture.coworkerCount}
      recordId={fixture.recordId}
      detailUrl={fixture.detailUrl}
      submittedAt={submittedAtForDevEmailFixture(fixture)}
      devFixtureLabel={fixture.label}
      selfForwardStatus={null}
    />
  );
}

function EmptyState({
  error,
  onRead,
}: {
  error: string | null;
  onRead: () => void;
}) {
  return (
    <div className="animate-pop-in flex flex-1 flex-col items-center justify-center px-8 text-center">
      <span className="bg-card-soft text-muted-foreground mb-4 flex size-14 items-center justify-center rounded-2xl shadow-edge">
        <MailOpen className="size-6" strokeWidth={1.75} aria-hidden="true" />
      </span>
      <h2 className="text-2xl font-semibold tracking-tight text-balance">No message open</h2>
      <p className="text-muted-foreground mt-1.5 max-w-[32ch] text-sm leading-relaxed text-pretty">
        {error ?? "Open a received message in Outlook, then sync it to Feishu from here."}
      </p>
      <Button variant="secondary" className="mt-4" onClick={onRead}>
        Read current email
      </Button>
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
  const params = new URLSearchParams(window.location.search);
  const useCoworkerFixtures = devPreview && params.has("e2eCoworkers");
  const requestedDevScreen = devPreview ? (params.get("devScreen") ?? params.get("devSceen")) : null;
  // "send" is an informal alias for the sync progress screen (Act IV).
  const normalizedDevScreen = requestedDevScreen === "send" ? "sync" : requestedDevScreen;
  const devScreen =
    normalizedDevScreen === "sync" || normalizedDevScreen === "received" || normalizedDevScreen === "login"
      ? normalizedDevScreen
      : null;
  const devFixtureKey = devPreview ? params.get("devFixture") : null;
  // "constra mode": ?mock=failed-uploads seeds the intake with fixture uploads so
  // the failed/retry/re-add attachment UI renders in `bun run dev` with no real
  // network. DEV + non-Outlook only (devPreview), so production can never enter it.
  const mockMode =
    devPreview && isMockUploadsMode(params.get("mock")) ? params.get("mock") : null;
  const mockUploads =
    mockMode && isMockUploadsMode(mockMode)
      ? buildMockUploadedFiles(mockMode)
      : undefined;
  const mockStagingDeps =
    mockMode && isMockUploadsMode(mockMode)
      ? buildMockStagingDeps(mockMode)
      : undefined;
  const item = mailItem ?? (devPreview ? DEV_SAMPLE : null);

  // Dev-only: clicking "Log in" advances straight to the logged-in UI (profile +
  // coworker picker) without the real OAuth popup. ?devUser=1 starts logged in.
  // Local-only fake login switches. No backend needed for UI smoke: use
  // `?devUser=1` (existing), `?fakeLogin=1`, or `?fake=1`.
  const forceFakeLogin =
    params.has("devUser") || params.has("dev") || params.has("fake") || params.has("fakeLogin");
  const showDevUser = devPreview && (devLoggedIn || forceFakeLogin);
  const devUser = showDevUser
    ? {
        openId: "ou_dev",
        userName: "Jenny Xu",
        email: "jenny.xu@fenchem.com",
        org: "Branch Sales",
        avatarUrl: "https://example.test/jenny.png",
      }
    : null;
  const isLoggedIn = feishuAuth.isLoggedIn || devUser !== null;
  // While the Convex session query is in flight, isLoggedIn is briefly false
  // even for a returning user with a valid cached session. RequestIntakeScreen
  // uses this to render a quiet placeholder instead of flashing the LoginScreen.
  const isAuthLoading = feishuAuth.isLoading && devUser === null;
  const user = feishuAuth.user ?? devUser;
  const handleLogin = devPreview ? () => setDevLoggedIn(true) : feishuAuth.login;
  const handleLoginFallback = devPreview ? () => setDevLoggedIn(true) : feishuAuth.loginFallback;
  const handleLogout = devPreview ? () => setDevLoggedIn(false) : feishuAuth.logout;
  const loginGate = isLoggedIn ? null : isAuthLoading ? (
    <AuthResolvingScreen
      onLogin={handleLogin}
      onLoginFallback={handleLoginFallback}
    />
  ) : (
    <LoginScreen onLogin={handleLogin} onLoginFallback={handleLoginFallback} />
  );
  const profileHeader =
    isLoggedIn && user ? (
      <section
        aria-label="Feishu account controls"
        className="flex items-center gap-1"
        data-profile-header="true"
      >
        <ThemeToggle />
        <FeishuProfile user={user} onLogout={handleLogout} />
      </section>
    ) : null;

  return (
    <div className="bg-background relative flex h-screen w-full flex-col overflow-hidden">
      {host !== null && !feishuAuth.isLoading ? (
        <BootReadyMilestone host={host} isLoggedIn={feishuAuth.isLoggedIn} />
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col">
        {devScreen ? (
          <DevScreenPreview screen={devScreen} devFixtureKey={devFixtureKey} />
        ) : item ? (
          <RequestIntakeScreen
            isLoggedIn={isLoggedIn}
            isAuthLoading={isAuthLoading}
            mailItem={item}
            sessionId={feishuAuth.sessionId}
            user={user ?? undefined}
            userAccessToken={feishuAuth.userAccessToken}
            usePreviewCoworkers={useCoworkerFixtures}
            devPreview={devPreview}
            mockUploads={mockUploads}
            mockStagingDeps={mockStagingDeps}
            profileSlot={profileHeader}
            onLogin={handleLogin}
            onLoginFallback={handleLoginFallback}
          />
        ) : loginGate ? (
          loginGate
        ) : loading ? null : (
          <EmptyState error={error} onRead={readCurrentItem} />
        )}
      </main>
    </div>
  );
}
