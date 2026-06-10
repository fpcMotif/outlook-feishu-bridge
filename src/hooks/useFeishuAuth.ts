import { useCallback, useState } from "react";
import { useAction, useQuery, useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { FeishuUser } from "../components/taskpane/feishuUser";
import { clearAuthSnapshot } from "./feishuAuthSnapshot";
import { wipeIntakeSessionsOnLogout } from "../components/taskpane/intakeSessionState";
import {
  useAuthState,
  useProactiveTouch,
  type FallbackToken,
  type UserSession,
} from "./useFeishuAuthState";

const SESSION_KEY = "feishu_session_id";
// Browser-held token from the box fallback login (ADR-0008). Only set when the
// user logs in via the "trouble logging in?" path; the primary Convex login
// stores the token server-side instead.
const FALLBACK_KEY = "feishu_fallback_token";

// User-identity scopes baked into the user_access_token. Feishu only grants
// scopes explicitly REQUESTED here at authorize time; omitting `scope` yields a
// token with default scopes only, so the search call fails with 99991679
// "app did not obtain the user's authorization" (see ADR-0003). Request only what
// we use (least privilege). Post-pivot (ADR-0010) the lone user-token call is
// Coworker search — the chat scopes (im:chat:readonly, im:message) are dropped.
//   contact:user:search → coworkers.ts GET /search/v1/user (search Coworkers; returns
//                          name/avatar/open_id - user_id would need employee_id:readonly)
//   offline_access      → required for the OIDC token endpoint to return a refresh_token
const FEISHU_USER_SCOPES = "contact:user:search offline_access";

export function getOrCreateSessionId(): string {
  let sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) {
    sessionId = crypto.randomUUID();
    localStorage.setItem(SESSION_KEY, sessionId);
  }
  return sessionId;
}

// Returns the stored fallback token only if present and not expired.
export function readFallbackToken(): FallbackToken | null {
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
  const appId = import.meta.env.VITE_FEISHU_APP_ID;
  const siteUrl = import.meta.env.VITE_CONVEX_SITE_URL;
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
export function parseFallbackMessage(message: string, sessionId: string): FallbackMessage {
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

export interface FeishuAuthState {
  sessionId: string;
  isLoading: boolean;
  isLoggedIn: boolean;
  user: FeishuUser | null;
  userAccessToken?: string;
  login: () => void;
  loginFallback: () => void;
  logout: () => Promise<void>;
}

function useAuthActions({
  logoutMutation,
  sessionId,
  setFallback,
}: {
  logoutMutation: (args: { sessionId: string }) => Promise<unknown>;
  sessionId: string;
  setFallback: (token: FallbackToken | null) => void;
}): Pick<FeishuAuthState, "login" | "loginFallback" | "logout"> {
  const login = useCallback(() => openFeishuOAuth(sessionId), [sessionId]);
  const loginFallback = useCallback(
    () => startFallbackLogin(sessionId, setFallback),
    [sessionId, setFallback],
  );
  const logout = useCallback(async () => {
    localStorage.removeItem(FALLBACK_KEY);
    clearAuthSnapshot();
    // Draft Maps are SPA-session lifetime and the pinned pane survives sign-out
    // without a reload — wipe them so one user's selections/file names + live
    // storageIds never linger for the next account.
    wipeIntakeSessionsOnLogout();
    setFallback(null);
    await logoutMutation({ sessionId });
  }, [logoutMutation, sessionId, setFallback]);

  return { login, loginFallback, logout };
}

export function useFeishuAuth(): FeishuAuthState {
  const [sessionId] = useState(getOrCreateSessionId);
  const session = useQuery(api.feishu.userAuth.getUserSession, { sessionId }) as UserSession;
  const logoutMutation = useMutation(api.feishu.userAuth.logoutUser);
  const touchSession = useAction(api.feishu.userAuth.touchSession);
  const [fallback, setFallback] = useState<FallbackToken | null>(readFallbackToken);
  // Proactive boot self-heal (one-shot, off the paint path); see useProactiveTouch.
  const touchResult = useProactiveTouch(touchSession, sessionId);

  // Snapshot reconcile + pure login-gate derivation (presence-horizon optimistic
  // paint until getUserSession contradicts it). See useAuthState/deriveAuthFlags.
  const { isLoading, isLoggedIn, user, userAccessToken } = useAuthState({
    session,
    sessionId,
    fallback,
    touchResult,
  });
  const { login, loginFallback, logout } = useAuthActions({ logoutMutation, sessionId, setFallback });

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
