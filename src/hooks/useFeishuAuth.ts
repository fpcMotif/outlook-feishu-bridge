import { useState, useCallback } from "react";
import { useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";

const SESSION_KEY = "feishu_session_id";
// Browser-held token from the box fallback login (ADR-0008). Only set when the
// user logs in via the "trouble logging in?" path; the primary Convex login
// stores the token server-side instead.
const FALLBACK_KEY = "feishu_fallback_token";

// User-identity scopes baked into the user_access_token. Feishu only grants
// scopes explicitly REQUESTED here at authorize time; omitting `scope` yields a
// token with default scopes only, so chat/contact calls fail with 99991679
// "app did not obtain the user's authorization" (see ADR-0003). All are enabled
// on the app (cli_a945ac390ff9dcc0). Request only what we use (least privilege).
//   im:chat:readonly    → groups.ts   GET  /im/v1/chats    (list the user's groups)
//   contact:user:search → contacts.ts GET  /search/v1/user (search users; returns
//                          name/avatar/open_id - user_id would need employee_id:readonly)
//   im:message          → im.ts       POST /im/v1/messages (forward as the user)
//   offline_access      → required for the OIDC token endpoint to return a refresh_token
const FEISHU_USER_SCOPES =
  "im:chat:readonly contact:user:search im:message offline_access";

interface FallbackToken {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  openId: string;
  userName: string | null;
  avatarUrl: string | null;
}

function getOrCreateSessionId(): string {
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  return sessionId;
}

// Returns the stored fallback token only if present and not expired.
function readFallbackToken(): FallbackToken | null {
  try {
    const raw = localStorage.getItem(FALLBACK_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as FallbackToken;
    if (!t.accessToken || t.expiresAt <= Date.now()) return null;
    return t;
  } catch {
    return null;
  }
}

// Primary login: open the Feishu authorize popup that redirects to the Convex
// OAuth Callback, which stores the token server-side. The SPA then learns of the
// login by polling getUserSession. Unchanged behaviour.
function openFeishuOAuth(sessionId: string) {
  const appId = import.meta.env.VITE_FEISHU_APP_ID as string | undefined;
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL as string | undefined;
  if (!appId || !siteUrl) {
    console.error("VITE_FEISHU_APP_ID and VITE_CONVEX_SITE_URL must be set");
    return;
  }
  const redirectUri = `${siteUrl}/feishu/oauth/callback`;
  const url = new URL("https://open.feishu.cn/open-apis/authen/v1/authorize");
  url.searchParams.set("app_id", appId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", sessionId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", FEISHU_USER_SCOPES);

  const w = 500;
  const h = 600;
  const left = window.screenX + (window.outerWidth - w) / 2;
  const top = window.screenY + (window.outerHeight - h) / 2;
  window.open(
    url.toString(),
    "feishu_oauth",
    `width=${w},height=${h},left=${left},top=${top},scrollbars=yes`,
  );
}

type FallbackMessage =
  | { kind: "ignore" }
  | { kind: "error"; error: string }
  | { kind: "token"; token: FallbackToken };

// Parse a DialogMessageReceived payload from the box fallback callback: "ignore"
// for messages that aren't ours (caller must NOT close the dialog), "error" for a
// malformed/failed feishu-fallback message, or the validated token. State is
// checked against sessionId (CSRF).
function parseFallbackMessage(message: string, sessionId: string): FallbackMessage {
  let payload: Partial<FallbackToken> & {
    source?: string;
    state?: string;
    error?: string;
  };
  try {
    payload = JSON.parse(message);
  } catch {
    return { kind: "ignore" };
  }
  if (payload.source !== "feishu-fallback") return { kind: "ignore" };
  if (
    payload.error ||
    payload.state !== sessionId ||
    !payload.accessToken ||
    !payload.expiresAt
  ) {
    return { kind: "error", error: payload.error ?? "invalid response" };
  }
  return {
    kind: "token",
    token: {
      accessToken: payload.accessToken,
      refreshToken: payload.refreshToken ?? null,
      expiresAt: payload.expiresAt,
      openId: payload.openId ?? "",
      userName: payload.userName ?? null,
      avatarUrl: payload.avatarUrl ?? null,
    },
  };
}

// Fallback login (ADR-0008): used when Convex's action runtime is down, so the
// Convex OAuth Callback 500s. Driven by the Office Dialog API because
// window.open/postMessage is unreliable in the Outlook taskpane. The dialog
// starts on our own domain (/feishu/oauth/start, served by the box Bun server),
// redirects to Feishu, and the box /callback messageParents the token back.
function startFallbackLogin(
  sessionId: string,
  onToken: (t: FallbackToken) => void,
): void {
  // Same origin as the SPA (the ECS Host) — required by the Office Dialog API.
  const startUrl = `${window.location.origin}/feishu/oauth/start?state=${encodeURIComponent(sessionId)}`;
  const ui = (globalThis as { Office?: typeof Office }).Office?.context?.ui;
  if (!ui?.displayDialogAsync) {
    console.error("Office Dialog API unavailable — fallback login needs the Outlook host");
    return;
  }
  ui.displayDialogAsync(startUrl, { height: 60, width: 40 }, (result) => {
    if (result.status !== Office.AsyncResultStatus.Succeeded) {
      console.error("displayDialogAsync failed:", result.error);
      return;
    }
    const dialog = result.value;
    dialog.addEventHandler(Office.EventType.DialogMessageReceived, (arg) => {
      const parsed = parseFallbackMessage((arg as { message: string }).message, sessionId);
      if (parsed.kind === "ignore") return;
      dialog.close();
      if (parsed.kind === "error") {
        console.error("fallback login failed:", parsed.error);
        return;
      }
      localStorage.setItem(FALLBACK_KEY, JSON.stringify(parsed.token));
      onToken(parsed.token);
    });
  });
}

export function useFeishuAuth() {
  const [sessionId] = useState(getOrCreateSessionId);
  const session = useQuery(api.feishu.userAuth.getUserSession, { sessionId });
  const logoutMutation = useMutation(api.feishu.userAuth.logoutUser);
  const [fallback, setFallback] = useState<FallbackToken | null>(readFallbackToken);

  const convexLoggedIn =
    session !== null && session !== undefined && !session.isExpired;
  const fallbackLoggedIn = fallback !== null && fallback.expiresAt > Date.now();
  // Don't block on Convex if a valid fallback token already proves we're in.
  const isLoading = session === undefined && fallback === null;
  const isLoggedIn = convexLoggedIn || fallbackLoggedIn;

  const login = useCallback(() => openFeishuOAuth(sessionId), [sessionId]);
  const loginFallback = useCallback(
    () => startFallbackLogin(sessionId, setFallback),
    [sessionId],
  );
  const logout = useCallback(async () => {
    localStorage.removeItem(FALLBACK_KEY);
    setFallback(null);
    await logoutMutation({ sessionId });
  }, [logoutMutation, sessionId]);

  // Convex (server-stored token) takes precedence; the fallback fills in only
  // when there's no live Convex session.
  const user = convexLoggedIn
    ? { openId: session.openId, userName: session.userName, avatarUrl: session.avatarUrl }
    : fallbackLoggedIn
      ? { openId: fallback.openId, userName: fallback.userName ?? undefined, avatarUrl: fallback.avatarUrl ?? undefined }
      : null;

  // Token to hand the Forward pipeline: set ONLY on the box-fallback path. When
  // undefined, the Convex action reads the token from its DB (the primary path).
  const userAccessToken =
    !convexLoggedIn && fallbackLoggedIn ? fallback.accessToken : undefined;

  return {
    sessionId,
    isLoading,
    isLoggedIn,
    user,
    userAccessToken,
    login,
    loginFallback,
    logout,
  };
}
