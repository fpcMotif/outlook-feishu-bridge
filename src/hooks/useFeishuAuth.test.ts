// Unit tests for the Feishu auth hook + its (now-exported) pure helpers.
//
// Two layers are covered:
//  1. The module-private-turned-exported pure helpers — getOrCreateSessionId,
//     readFallbackToken, parseFallbackMessage — which carry the CSRF/state and
//     token-parsing branches. These are exercised directly (cheap, exhaustive).
//  2. The useFeishuAuth hook body — convex-vs-fallback precedence, isLoading,
//     login()/openFeishuOAuth env guard, logout(), and the box-fallback Office
//     Dialog path (startFallbackLogin) — via renderHook with convex/react mocked
//     and globalThis.Office stubbed (mailBody.test.ts Office-stub pattern).
//
// The Feishu authorize endpoint + scope behaviour mirrors the official OAuth docs
// (https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/authen-v1/authorize).

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// convex/react mock. The hook calls useQuery(getUserSession) and
// useMutation(logoutUser). We make both controllable per-test through module
// variables the mock factory closes over (factory is hoisted, so the variables
// must be declared via vi.hoisted).
// ---------------------------------------------------------------------------
const h = vi.hoisted(() => ({
  sessionValue: undefined as unknown,
  logoutMock: vi.fn(async () => undefined),
}));

vi.mock("convex/react", () => ({
  useQuery: () => h.sessionValue,
  useMutation: () => h.logoutMock,
}));

import {
  getOrCreateSessionId,
  parseFallbackMessage,
  readFallbackToken,
  useFeishuAuth,
} from "./useFeishuAuth";

const SESSION_KEY = "feishu_session_id";
const FALLBACK_KEY = "feishu_fallback_token";
const FEISHU_USER_SCOPES = "contact:user:search offline_access";

// A valid (non-expired) fallback token row as written by the box callback.
function freshFallback(overrides: Record<string, unknown> = {}) {
  return {
    accessToken: "u-access-tok",
    refreshToken: "u-refresh-tok",
    expiresAt: Date.now() + 60_000,
    openId: "ou_fallback",
    userName: "Fallback User",
    avatarUrl: "https://img/fallback.png",
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  h.sessionValue = undefined;
  h.logoutMock = vi.fn(async () => undefined);
});

afterEach(() => {
  delete (globalThis as unknown as { Office?: unknown }).Office;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ===========================================================================
// getOrCreateSessionId
// ===========================================================================
describe("getOrCreateSessionId", () => {
  it("generates and persists a UUID when SESSION_KEY is absent", () => {
    expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    const id = getOrCreateSessionId();
    expect(id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu,
    );
    expect(localStorage.getItem(SESSION_KEY)).toBe(id);
  });

  it("reuses the stored id on subsequent calls (stable session id)", () => {
    const first = getOrCreateSessionId();
    const second = getOrCreateSessionId();
    expect(second).toBe(first);
    expect(localStorage.getItem(SESSION_KEY)).toBe(first);
  });
});

// ===========================================================================
// readFallbackToken
// ===========================================================================
describe("readFallbackToken", () => {
  it("returns null when no fallback key is stored", () => {
    expect(readFallbackToken()).toBeNull();
  });

  it("returns null for malformed JSON (catch branch)", () => {
    localStorage.setItem(FALLBACK_KEY, "{not valid json");
    expect(readFallbackToken()).toBeNull();
  });

  it("returns null when the stored token has no accessToken", () => {
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify(freshFallback({ accessToken: "" })),
    );
    expect(readFallbackToken()).toBeNull();
  });

  it("returns null when the stored token is expired (expiresAt <= now)", () => {
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify(freshFallback({ expiresAt: Date.now() - 1 })),
    );
    expect(readFallbackToken()).toBeNull();
  });

  it("returns the token when present and not expired", () => {
    const token = freshFallback();
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(token));
    expect(readFallbackToken()).toEqual(token);
  });
});

// ===========================================================================
// parseFallbackMessage — CSRF/state validation + token shaping
// ===========================================================================
describe("parseFallbackMessage", () => {
  const SID = "sess-123";

  it("returns {kind:'ignore'} for non-JSON input (catch branch)", () => {
    expect(parseFallbackMessage("not json", SID)).toEqual({ kind: "ignore" });
  });

  it("returns {kind:'ignore'} when source is not 'feishu-fallback'", () => {
    const msg = JSON.stringify({ source: "something-else", state: SID });
    expect(parseFallbackMessage(msg, SID)).toEqual({ kind: "ignore" });
  });

  it("returns {kind:'error'} carrying payload.error when the callback reported one", () => {
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: SID,
      error: "user_denied",
      accessToken: "x",
      expiresAt: Date.now() + 1000,
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "error",
      error: "user_denied",
    });
  });

  it("returns {kind:'error', error:'invalid response'} on a state mismatch (CSRF)", () => {
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: "attacker-state",
      accessToken: "x",
      expiresAt: Date.now() + 1000,
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "error",
      error: "invalid response",
    });
  });

  it("returns {kind:'error'} when accessToken is missing", () => {
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: SID,
      expiresAt: Date.now() + 1000,
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "error",
      error: "invalid response",
    });
  });

  it("returns {kind:'error'} when expiresAt is missing", () => {
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: SID,
      accessToken: "x",
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "error",
      error: "invalid response",
    });
  });

  it("returns {kind:'token'} with the full payload on a valid message", () => {
    const expiresAt = Date.now() + 30_000;
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: SID,
      accessToken: "acc",
      refreshToken: "ref",
      expiresAt,
      openId: "ou_1",
      userName: "Jane",
      avatarUrl: "https://img/jane.png",
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "token",
      token: {
        accessToken: "acc",
        refreshToken: "ref",
        expiresAt,
        openId: "ou_1",
        userName: "Jane",
        avatarUrl: "https://img/jane.png",
      },
    });
  });

  it("null-coalesces refreshToken/openId/userName/avatarUrl when omitted", () => {
    const expiresAt = Date.now() + 30_000;
    const msg = JSON.stringify({
      source: "feishu-fallback",
      state: SID,
      accessToken: "acc",
      expiresAt,
    });
    expect(parseFallbackMessage(msg, SID)).toEqual({
      kind: "token",
      token: {
        accessToken: "acc",
        refreshToken: null,
        expiresAt,
        openId: "",
        userName: null,
        avatarUrl: null,
      },
    });
  });
});

// ===========================================================================
// useFeishuAuth — state derivation (isLoading / login state / user / token)
// ===========================================================================
describe("useFeishuAuth — derived state", () => {
  it("isLoading is true while session is undefined AND no fallback token exists", () => {
    h.sessionValue = undefined; // convex query still resolving
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.isLoggedIn).toBe(false);
    expect(result.current.user).toBeNull();
    expect(result.current.userAccessToken).toBeUndefined();
  });

  it("isLoading is false once a valid fallback token exists, even with session undefined", () => {
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(freshFallback()));
    h.sessionValue = undefined;
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoading).toBe(false);
  });

  it("convex session present and not expired drives isLoggedIn + user (convex wins)", () => {
    h.sessionValue = {
      isExpired: false,
      openId: "ou_convex",
      userName: "Convex User",
      avatarUrl: "https://img/convex.png",
    };
    // A fallback token is ALSO present, to prove convex takes precedence.
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(freshFallback()));
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: "ou_convex",
      userName: "Convex User",
      avatarUrl: "https://img/convex.png",
    });
    // Convex path reads its token server-side, so no client token is exposed.
    expect(result.current.userAccessToken).toBeUndefined();
  });

  it("an expired convex session is treated as logged out", () => {
    h.sessionValue = {
      isExpired: true,
      openId: "ou_convex",
      userName: "Convex User",
      avatarUrl: null,
    };
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it("fallback token (no convex session) drives isLoggedIn + user, mapping null->undefined", () => {
    h.sessionValue = null; // convex resolved: not logged in
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify(
        freshFallback({ userName: null, avatarUrl: null, openId: "ou_fb" }),
      ),
    );
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: "ou_fb",
      userName: undefined,
      avatarUrl: undefined,
    });
  });

  it("userAccessToken is set ONLY on the fallback-only path", () => {
    h.sessionValue = null;
    localStorage.setItem(
      FALLBACK_KEY,
      JSON.stringify(freshFallback({ accessToken: "the-fallback-token" })),
    );
    const { result } = renderHook(() => useFeishuAuth());
    expect(result.current.userAccessToken).toBe("the-fallback-token");
  });
});

// ===========================================================================
// useFeishuAuth — logout
// ===========================================================================
describe("useFeishuAuth — logout", () => {
  it("removes the fallback key, clears fallback state, and awaits logoutMutation", async () => {
    h.sessionValue = null;
    localStorage.setItem(FALLBACK_KEY, JSON.stringify(freshFallback()));
    const { result } = renderHook(() => useFeishuAuth());

    // Logged in via fallback before logout.
    expect(result.current.isLoggedIn).toBe(true);
    const sid = result.current.sessionId;

    await act(async () => {
      await result.current.logout();
    });

    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    expect(h.logoutMock).toHaveBeenCalledWith({ sessionId: sid });
    // Fallback state cleared -> no longer logged in (convex session is null).
    expect(result.current.isLoggedIn).toBe(false);
    expect(result.current.user).toBeNull();
  });
});

// ===========================================================================
// useFeishuAuth — login() / openFeishuOAuth
// ===========================================================================
describe("useFeishuAuth — login (openFeishuOAuth)", () => {
  it("opens the Feishu authorize popup with app_id/redirect/state/scope when env is set", () => {
    vi.stubEnv("VITE_FEISHU_APP_ID", "cli_app_123");
    vi.stubEnv("VITE_CONVEX_SITE_URL", "https://site.convex.site");
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);

    const { result } = renderHook(() => useFeishuAuth());
    const sid = result.current.sessionId;

    act(() => {
      result.current.login();
    });

    expect(openSpy).toHaveBeenCalledTimes(1);
    const [urlArg, target, features] = openSpy.mock.calls[0];
    const url = new URL(urlArg as string);
    expect(url.origin + url.pathname).toBe(
      "https://open.feishu.cn/open-apis/authen/v1/authorize",
    );
    expect(url.searchParams.get("app_id")).toBe("cli_app_123");
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://site.convex.site/feishu/oauth/callback",
    );
    expect(url.searchParams.get("state")).toBe(sid);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("scope")).toBe(FEISHU_USER_SCOPES);
    expect(target).toBe("feishu_oauth");
    expect(features).toContain("width=500");
    expect(features).toContain("height=600");
  });

  it("logs an error and does NOT open a window when VITE_FEISHU_APP_ID is missing", () => {
    vi.stubEnv("VITE_FEISHU_APP_ID", "");
    vi.stubEnv("VITE_CONVEX_SITE_URL", "https://site.convex.site");
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.login();
    });

    expect(openSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(
      "VITE_FEISHU_APP_ID and VITE_CONVEX_SITE_URL must be set",
    );
  });

  it("logs an error and does NOT open a window when VITE_CONVEX_SITE_URL is missing", () => {
    vi.stubEnv("VITE_FEISHU_APP_ID", "cli_app_123");
    vi.stubEnv("VITE_CONVEX_SITE_URL", "");
    const openSpy = vi.fn();
    vi.stubGlobal("open", openSpy);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.login();
    });

    expect(openSpy).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalled();
  });
});

// ===========================================================================
// useFeishuAuth — loginFallback / startFallbackLogin (Office Dialog API)
// ===========================================================================

// Office stub helpers, mirroring src/office/mailBody.test.ts. Only the bits the
// fallback dialog path touches are present.
type DialogHandler = (arg: { message: string }) => void;

interface FakeDialog {
  close: ReturnType<typeof vi.fn>;
  addEventHandler: (eventType: unknown, handler: DialogHandler) => void;
  handlerRef?: DialogHandler;
}

function installOffice(opts: {
  displayDialogAsync?: (
    url: string,
    options: unknown,
    cb: (result: {
      status: string;
      value?: FakeDialog;
      error?: unknown;
    }) => void,
  ) => void;
  noUi?: boolean;
}) {
  const ui = opts.noUi
    ? {}
    : { displayDialogAsync: opts.displayDialogAsync };
  (globalThis as unknown as { Office: unknown }).Office = {
    AsyncResultStatus: { Succeeded: "succeeded", Failed: "failed" },
    EventType: { DialogMessageReceived: "dialogMessageReceived" },
    context: { ui },
  };
}

// Build a fresh fake dialog that records the registered DialogMessageReceived
// handler so tests can drive it directly.
function makeDialog(): FakeDialog {
  const dialog: FakeDialog = {
    close: vi.fn(),
    addEventHandler(_eventType, handler) {
      dialog.handlerRef = handler;
    },
  };
  return dialog;
}

describe("useFeishuAuth — loginFallback (startFallbackLogin)", () => {
  beforeEach(() => {
    // The fallback start URL is built from window.location.origin; jsdom
    // provides a default (http://localhost), which is fine for the assertion.
  });

  it("logs and returns when Office.context.ui.displayDialogAsync is unavailable", () => {
    installOffice({ noUi: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.loginFallback();
    });

    expect(errSpy).toHaveBeenCalledWith(
      "Office Dialog API unavailable — fallback login needs the Outlook host",
    );
  });

  it("logs and returns when displayDialogAsync reports a Failed status", () => {
    installOffice({
      displayDialogAsync: (_url, _options, cb) =>
        cb({ status: "failed", error: { message: "popup blocked" } }),
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.loginFallback();
    });

    expect(errSpy).toHaveBeenCalledWith("displayDialogAsync failed:", {
      message: "popup blocked",
    });
  });

  it("passes the same-origin start URL carrying the sessionId state to displayDialogAsync", () => {
    let capturedUrl = "";
    installOffice({
      displayDialogAsync: (url, _options, _cb) => {
        capturedUrl = url;
        // Don't invoke the callback — just assert the URL shape.
      },
    });

    const { result } = renderHook(() => useFeishuAuth());
    const sid = result.current.sessionId;
    act(() => {
      result.current.loginFallback();
    });

    const url = new URL(capturedUrl);
    expect(url.origin).toBe(window.location.origin);
    expect(url.pathname).toBe("/feishu/oauth/start");
    expect(url.searchParams.get("state")).toBe(sid);
  });

  it("registers a DialogMessageReceived handler on a Succeeded dialog", () => {
    const dialog = makeDialog();
    installOffice({
      displayDialogAsync: (_url, _options, cb) =>
        cb({ status: "succeeded", value: dialog }),
    });

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.loginFallback();
    });

    expect(dialog.handlerRef).toBeTypeOf("function");
  });

  it("handler keeps the dialog OPEN for an 'ignore' message (foreign message)", () => {
    const dialog = makeDialog();
    installOffice({
      displayDialogAsync: (_url, _options, cb) =>
        cb({ status: "succeeded", value: dialog }),
    });

    const { result } = renderHook(() => useFeishuAuth());
    act(() => {
      result.current.loginFallback();
    });

    // A message that isn't ours -> parseFallbackMessage returns 'ignore'.
    act(() => {
      dialog.handlerRef?.({ message: JSON.stringify({ source: "other" }) });
    });

    expect(dialog.close).not.toHaveBeenCalled();
    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
    expect(result.current.isLoggedIn).toBe(false);
  });

  it("handler closes the dialog and logs for an 'error' message", () => {
    const dialog = makeDialog();
    installOffice({
      displayDialogAsync: (_url, _options, cb) =>
        cb({ status: "succeeded", value: dialog }),
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useFeishuAuth());
    const sid = result.current.sessionId;
    act(() => {
      result.current.loginFallback();
    });

    act(() => {
      dialog.handlerRef?.({
        message: JSON.stringify({
          source: "feishu-fallback",
          state: sid,
          error: "denied",
        }),
      });
    });

    expect(dialog.close).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith("fallback login failed:", "denied");
    expect(localStorage.getItem(FALLBACK_KEY)).toBeNull();
  });

  it("handler closes the dialog, persists the token, and logs the user in for a valid token", () => {
    const dialog = makeDialog();
    installOffice({
      displayDialogAsync: (_url, _options, cb) =>
        cb({ status: "succeeded", value: dialog }),
    });
    h.sessionValue = null; // no convex session, so the fallback governs login

    const { result } = renderHook(() => useFeishuAuth());
    const sid = result.current.sessionId;
    act(() => {
      result.current.loginFallback();
    });

    const expiresAt = Date.now() + 60_000;
    act(() => {
      dialog.handlerRef?.({
        message: JSON.stringify({
          source: "feishu-fallback",
          state: sid,
          accessToken: "tok-from-dialog",
          refreshToken: "ref",
          expiresAt,
          openId: "ou_dialog",
          userName: "Dialog User",
          avatarUrl: "https://img/dialog.png",
        }),
      });
    });

    expect(dialog.close).toHaveBeenCalledTimes(1);
    const stored = JSON.parse(localStorage.getItem(FALLBACK_KEY) ?? "null");
    expect(stored).toMatchObject({
      accessToken: "tok-from-dialog",
      openId: "ou_dialog",
    });
    // setFallback was called via onToken -> hook re-derives a logged-in state.
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: "ou_dialog",
      userName: "Dialog User",
      avatarUrl: "https://img/dialog.png",
    });
    expect(result.current.userAccessToken).toBe("tok-from-dialog");
  });
});
