'use client';

/**
 * Authentication context provider for the Chalk application.
 * Manages auth state (token, user info, isAuthenticated) via React Context.
 * Handles token refresh, 401 redirects, and provides a retry banner for 503 errors.
 *
 * Requirements: 10.1, 10.5, 10.6, 9.4, 9.5
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import {
  type AuthUser,
  clearTokens,
  exchangeCodeForTokens,
  extractUserFromToken,
  getAccessToken,
  getUserInfo,
  isTokenExpired,
  refreshAccessToken,
  setAccessToken,
  setRefreshToken,
  setUserInfo,
} from '@/lib/auth';

// =============================================================================
// Context Types
// =============================================================================

export interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: () => void;
  logout: () => void;
  showRetryBanner: boolean;
  dismissRetryBanner: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// =============================================================================
// Hook
// =============================================================================

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// =============================================================================
// Provider
// =============================================================================

export interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showRetryBanner, setShowRetryBanner] = useState(false);

  const isAuthenticated = user !== null;

  // Initialize auth state from stored tokens
  useEffect(() => {
    async function initAuth() {
      // Check for OAuth callback code in URL
      const params = new URLSearchParams(window.location.search);
      const code = params.get('code');

      if (code) {
        const tokens = await exchangeCodeForTokens(code);
        if (tokens) {
          setAccessToken(tokens.accessToken);
          setRefreshToken(tokens.refreshToken);
          const userFromToken = extractUserFromToken(tokens.accessToken);
          if (userFromToken) {
            setUserInfo(userFromToken);
            setUser(userFromToken);
          }
        }
        // Clean the URL
        window.history.replaceState({}, '', window.location.pathname);
        setIsLoading(false);
        return;
      }

      // Check for existing token
      const token = getAccessToken();
      if (!token) {
        setIsLoading(false);
        return;
      }

      if (isTokenExpired(token)) {
        const refreshed = await refreshAccessToken();
        if (refreshed) {
          const userFromToken = extractUserFromToken(refreshed);
          if (userFromToken) {
            setUserInfo(userFromToken);
            setUser(userFromToken);
          }
        } else {
          clearTokens();
        }
      } else {
        const stored = getUserInfo();
        if (stored) {
          setUser(stored);
        } else {
          const userFromToken = extractUserFromToken(token);
          if (userFromToken) {
            setUserInfo(userFromToken);
            setUser(userFromToken);
          }
        }
      }

      setIsLoading(false);
    }

    initAuth();
  }, []);

  const login = useCallback(() => {
    const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
    const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
    const redirectUri = encodeURIComponent(
      process.env.NEXT_PUBLIC_REDIRECT_URI ?? `${window.location.origin}/login`
    );
    window.location.href =
      `${domain}/login?client_id=${clientId}&response_type=code&scope=openid+email+profile&redirect_uri=${redirectUri}`;
  }, []);

  const logout = useCallback(() => {
    clearTokens();
    setUser(null);
    const domain = process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
    const clientId = process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
    const redirectUri = encodeURIComponent(
      process.env.NEXT_PUBLIC_REDIRECT_URI ?? `${window.location.origin}/login`
    );
    window.location.href =
      `${domain}/logout?client_id=${clientId}&logout_uri=${redirectUri}`;
  }, []);

  const dismissRetryBanner = useCallback(() => {
    setShowRetryBanner(false);
  }, []);

  // Listen for 503 errors to display the retry banner
  useEffect(() => {
    function handlePersistenceError(event: CustomEvent) {
      if (event.detail?.status === 503) {
        setShowRetryBanner(true);
      }
    }

    window.addEventListener(
      'chalk:persistence-error',
      handlePersistenceError as EventListener
    );
    return () => {
      window.removeEventListener(
        'chalk:persistence-error',
        handlePersistenceError as EventListener
      );
    };
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated,
      isLoading,
      login,
      logout,
      showRetryBanner,
      dismissRetryBanner,
    }),
    [user, isAuthenticated, isLoading, login, logout, showRetryBanner, dismissRetryBanner]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
