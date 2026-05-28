/* eslint-disable max-lines */
/* eslint-disable unicorn/no-useless-undefined */
/* eslint-disable max-lines-per-function */
import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFeishuAuth } from './useFeishuAuth';

// Mock dependencies
const mockUseQuery = vi.fn();
const mockUseMutation = vi.fn();

vi.mock('convex/react', () => ({
  useQuery: (...args: any[]) => mockUseQuery(...args),
  useMutation: (...args: any[]) => mockUseMutation(...args),
}));

vi.mock('../../convex/_generated/api', () => ({
  api: {
    feishu: {
      userAuth: {
        getUserSession: 'mock_getUserSession',
        logoutUser: 'mock_logoutUser',
      },
    },
  },
}));

describe('useFeishuAuth', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();

    mockUseQuery.mockReturnValue(undefined);
    mockUseMutation.mockReturnValue(vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should create and retrieve sessionId', () => {
    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.sessionId).toBeTruthy();
    expect(localStorage.getItem('feishu_session_id')).toBe(result.current.sessionId);

    // Should reuse the same session ID
    const { result: result2 } = renderHook(() => useFeishuAuth());
    expect(result2.current.sessionId).toBe(result.current.sessionId);
  });

  it('should handle standard Convex login', () => {
    const mockSession = {
      openId: 'ou_123',
      userName: 'John Doe',
      avatarUrl: 'https://example.com/avatar.png',
      isExpired: false
    };
    mockUseQuery.mockReturnValue(mockSession);

    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: 'ou_123',
      userName: 'John Doe',
      avatarUrl: 'https://example.com/avatar.png'
    });
    // Only for fallback
    expect(result.current.userAccessToken).toBeUndefined();
  });

  it('should handle fallback login', () => {
    // Session query returns undefined (no convex session)
    mockUseQuery.mockReturnValue(undefined);

    // Setup fallback token in localStorage
    const fallbackToken = {
      accessToken: 't-12345',
      refreshToken: 'r-12345',
      // 1 hour from now
      expiresAt: Date.now() + 3600000,
      openId: 'ou_456',
      userName: 'Jane Doe',
      avatarUrl: 'https://example.com/jane.png'
    };
    localStorage.setItem('feishu_fallback_token', JSON.stringify(fallbackToken));

    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoading).toBe(false);
    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: 'ou_456',
      userName: 'Jane Doe',
      avatarUrl: 'https://example.com/jane.png'
    });
    expect(result.current.userAccessToken).toBe('t-12345');
  });

  it('should prefer Convex login over fallback login', () => {
    // Both active
    const mockSession = {
      openId: 'ou_convex',
      userName: 'Convex User',
      avatarUrl: null,
      isExpired: false
    };
    mockUseQuery.mockReturnValue(mockSession);

    const fallbackToken = {
      accessToken: 't-12345',
      refreshToken: null,
      expiresAt: Date.now() + 3600000,
      openId: 'ou_fallback',
      userName: 'Fallback User',
      avatarUrl: null
    };
    localStorage.setItem('feishu_fallback_token', JSON.stringify(fallbackToken));

    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.user).toEqual({
      openId: 'ou_convex',
      userName: 'Convex User',
      avatarUrl: null
    });
    // Should use convex, so token is undefined
    expect(result.current.userAccessToken).toBeUndefined();
  });

  it('should ignore expired fallback tokens', () => {
    mockUseQuery.mockReturnValue(undefined);

    const fallbackToken = {
      accessToken: 't-12345',
      refreshToken: null,
      // expired 1 hour ago
      expiresAt: Date.now() - 3600000,
      openId: 'ou_fallback',
      userName: null,
      avatarUrl: null
    };
    localStorage.setItem('feishu_fallback_token', JSON.stringify(fallbackToken));

    const { result } = renderHook(() => useFeishuAuth());

    expect(result.current.isLoggedIn).toBe(false);
    expect(result.current.user).toBeNull();
  });

  it('should perform logout correctly', async () => {
    const mockLogoutMutationFn = vi.fn();
    mockUseMutation.mockReturnValue(mockLogoutMutationFn);
    mockUseQuery.mockReturnValue(undefined);

    // Set fallback token
    const fallbackToken = {
      accessToken: 't-12345',
      refreshToken: null,
      expiresAt: Date.now() + 3600000,
      openId: 'ou_fallback',
      userName: null,
      avatarUrl: null
    };
    localStorage.setItem('feishu_fallback_token', JSON.stringify(fallbackToken));

    const { result } = renderHook(() => useFeishuAuth());

    // Initially logged in via fallback
    expect(result.current.isLoggedIn).toBe(true);

    await act(async () => {
      await result.current.logout();
    });

    // Check localStorage cleared
    expect(localStorage.getItem('feishu_fallback_token')).toBeNull();
    // Check mutation called
    expect(mockLogoutMutationFn).toHaveBeenCalledWith({ sessionId: result.current.sessionId });
    // State should reflect logout for fallback
    expect(result.current.isLoggedIn).toBe(false);
  });

  it('should trigger login via openFeishuOAuth', () => {
    // Mock window.open
    const mockOpen = vi.fn();
    vi.stubGlobal('open', mockOpen);

    import.meta.env.VITE_FEISHU_APP_ID = 'test_app_id';
    import.meta.env.VITE_CONVEX_SITE_URL = 'https://test.site.com';

    const { result } = renderHook(() => useFeishuAuth());

    act(() => {
      result.current.login();
    });

    expect(mockOpen).toHaveBeenCalled();
    const [url, target, features] = mockOpen.mock.calls[0];

    expect(target).toBe('feishu_oauth');
    expect(features).toContain('width=500');

    const parsedUrl = new URL(url);
    expect(parsedUrl.hostname).toBe('open.feishu.cn');
    expect(parsedUrl.searchParams.get('app_id')).toBe('test_app_id');
    expect(parsedUrl.searchParams.get('redirect_uri')).toBe('https://test.site.com/feishu/oauth/callback');
    expect(parsedUrl.searchParams.get('state')).toBe(result.current.sessionId);

    // Cleanup
    vi.unstubAllGlobals();
  });

  it('should trigger loginFallback via Office Dialog API', () => {
    // Setup Office global mock
    const mockAddEventHandler = vi.fn();
    const mockDisplayDialogAsync = vi.fn((_url, _options, callback) => {
      callback({
        status: 'succeeded',
        value: {
          addEventHandler: mockAddEventHandler,
          close: vi.fn()
        }
      });
    });

    globalThis.Office = {
      context: {
        ui: {
          displayDialogAsync: mockDisplayDialogAsync
        }
      },
      AsyncResultStatus: { Succeeded: 'succeeded' },
      EventType: { DialogMessageReceived: 'dialogMessageReceived' }
    } as any;

    const { result } = renderHook(() => useFeishuAuth());

    act(() => {
      result.current.loginFallback();
    });

    expect(mockDisplayDialogAsync).toHaveBeenCalled();
    const [url] = mockDisplayDialogAsync.mock.calls[0];
    expect(url).toContain('/feishu/oauth/start?state=');

    // Simulate receiving token message
    const validMessage = {
      source: 'feishu-fallback',
      state: result.current.sessionId,
      accessToken: 't-from-dialog',
      expiresAt: Date.now() + 3600000,
      openId: 'ou_dialog'
    };

    const handler = mockAddEventHandler.mock.calls[0][1];

    act(() => {
      handler({ message: JSON.stringify(validMessage) });
    });

    expect(result.current.isLoggedIn).toBe(true);
    expect(result.current.userAccessToken).toBe('t-from-dialog');

    // Verify it was saved to localStorage
    const saved = JSON.parse(localStorage.getItem('feishu_fallback_token')!);
    expect(saved.accessToken).toBe('t-from-dialog');

    // Cleanup
    delete (globalThis as any).Office;
  });

  it('should ignore irrelevant messages in fallback login', () => {
    // Setup Office global mock
    const mockAddEventHandler = vi.fn();
    const mockDisplayDialogAsync = vi.fn((_url, _options, callback) => {
      callback({
        status: 'succeeded',
        value: {
          addEventHandler: mockAddEventHandler,
          close: vi.fn()
        }
      });
    });

    globalThis.Office = {
      context: {
        ui: {
          displayDialogAsync: mockDisplayDialogAsync
        }
      },
      AsyncResultStatus: { Succeeded: 'succeeded' },
      EventType: { DialogMessageReceived: 'dialogMessageReceived' }
    } as any;

    const { result } = renderHook(() => useFeishuAuth());

    act(() => {
      result.current.loginFallback();
    });

    const handler = mockAddEventHandler.mock.calls[0][1];

    // Simulate irrelevant message
    const invalidMessage = {
      source: 'some-other-source',
      data: 'something'
    };

    act(() => {
      handler({ message: JSON.stringify(invalidMessage) });
    });

    // Should not log in or throw
    expect(result.current.isLoggedIn).toBe(false);

    // Cleanup
    delete (globalThis as any).Office;
  });

  it('should handle fallback login errors', () => {
    const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    // Setup Office global mock
    const mockAddEventHandler = vi.fn();
    const mockDisplayDialogAsync = vi.fn((_url, _options, callback) => {
      callback({
        status: 'succeeded',
        value: {
          addEventHandler: mockAddEventHandler,
          close: vi.fn()
        }
      });
    });

    globalThis.Office = {
      context: {
        ui: {
          displayDialogAsync: mockDisplayDialogAsync
        }
      },
      AsyncResultStatus: { Succeeded: 'succeeded' },
      EventType: { DialogMessageReceived: 'dialogMessageReceived' }
    } as any;

    const { result } = renderHook(() => useFeishuAuth());

    act(() => {
      result.current.loginFallback();
    });

    const handler = mockAddEventHandler.mock.calls[0][1];

    // Simulate error message
    const errorMessage = {
      source: 'feishu-fallback',
      state: result.current.sessionId,
      error: 'access_denied'
    };

    act(() => {
      handler({ message: JSON.stringify(errorMessage) });
    });

    // Should stay logged out
    expect(result.current.isLoggedIn).toBe(false);
    expect(mockConsoleError).toHaveBeenCalledWith('fallback login failed:', 'access_denied');

    // Cleanup
    mockConsoleError.mockRestore();
    delete (globalThis as any).Office;
  });
});
