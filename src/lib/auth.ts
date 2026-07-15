/**
 * Authentication utilities for the Chalk frontend.
 * Handles token storage, expiry checks, API fetching with auth headers,
 * and localStorage-based pending message queuing for offline resilience.
 *
 * Requirements: 10.1, 10.5, 10.6, 9.4, 9.5
 */

// =============================================================================
// Constants
// =============================================================================

const ACCESS_TOKEN_KEY = 'chalk_access_token';
const REFRESH_TOKEN_KEY = 'chalk_refresh_token';
const USER_INFO_KEY = 'chalk_user_info';
const PENDING_MESSAGES_KEY = 'chalk_pending_messages';
const TOKEN_EXPIRY_BUFFER_MS = 60_000; // Refresh 1 minute before expiry

// =============================================================================
// Types
// =============================================================================

export interface AuthUser {
  userId: string;
  email: string;
  teams: string[];
}

export interface PendingMessage {
  id: string;
  threadId: string;
  content: string;
  createdAt: string;
}

export interface TokenPayload {
  sub: string;
  email?: string;
  'cognito:groups'?: string[];
  exp: number;
  iat: number;
}

// =============================================================================
// Token Storage
// =============================================================================

export function getAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

export function setAccessToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(ACCESS_TOKEN_KEY, token);
}

export function getRefreshToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function setRefreshToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(REFRESH_TOKEN_KEY, token);
}

export function clearTokens(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  localStorage.removeItem(USER_INFO_KEY);
}

// =============================================================================
// Token Decoding & Expiry
// =============================================================================

export function decodeToken(token: string): TokenPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(atob(parts[1]));
    return payload as TokenPayload;
  } catch {
    return null;
  }
}

export function isTokenExpired(token: string): boolean {
  const payload = decodeToken(token);
  if (!payload) return true;
  const now = Date.now();
  const expiresAt = payload.exp * 1000;
  return now >= expiresAt - TOKEN_EXPIRY_BUFFER_MS;
}

// =============================================================================
// User Info
// =============================================================================

export function getUserInfo(): AuthUser | null {
  if (typeof window === 'undefined') return null;
  const stored = localStorage.getItem(USER_INFO_KEY);
  if (!stored) return null;
  try {
    return JSON.parse(stored) as AuthUser;
  } catch {
    return null;
  }
}

export function setUserInfo(user: AuthUser): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(USER_INFO_KEY, JSON.stringify(user));
}

export function extractUserFromToken(token: string): AuthUser | null {
  const payload = decodeToken(token);
  if (!payload) return null;
  return {
    userId: payload.sub,
    email: payload.email ?? '',
    teams: payload['cognito:groups'] ?? [],
  };
}

// =============================================================================
// Cognito OAuth Helpers
// =============================================================================

function getCognitoDomain(): string {
  return process.env.NEXT_PUBLIC_COGNITO_DOMAIN ?? '';
}

function getCognitoClientId(): string {
  return process.env.NEXT_PUBLIC_COGNITO_CLIENT_ID ?? '';
}

function getRedirectUri(): string {
  return process.env.NEXT_PUBLIC_REDIRECT_URI ?? `${window.location.origin}/login`;
}

export function getLoginUrl(): string {
  const domain = getCognitoDomain();
  const clientId = getCognitoClientId();
  const redirectUri = encodeURIComponent(getRedirectUri());
  return `${domain}/login?client_id=${clientId}&response_type=code&scope=openid+email+profile&redirect_uri=${redirectUri}`;
}

export function getLogoutUrl(): string {
  const domain = getCognitoDomain();
  const clientId = getCognitoClientId();
  const redirectUri = encodeURIComponent(getRedirectUri());
  return `${domain}/logout?client_id=${clientId}&logout_uri=${redirectUri}`;
}

/**
 * Exchanges an authorization code for tokens via the Cognito token endpoint.
 */
export async function exchangeCodeForTokens(code: string): Promise<{
  accessToken: string;
  refreshToken: string;
} | null> {
  const domain = getCognitoDomain();
  const clientId = getCognitoClientId();
  const redirectUri = getRedirectUri();

  try {
    const response = await fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        redirect_uri: redirectUri,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
    };
  } catch {
    return null;
  }
}

/**
 * Refreshes the access token using the refresh token.
 * Returns new access token or null on failure (triggers redirect to login).
 */
export async function refreshAccessToken(): Promise<string | null> {
  const refreshToken = getRefreshToken();
  if (!refreshToken) return null;

  const domain = getCognitoDomain();
  const clientId = getCognitoClientId();

  try {
    const response = await fetch(`${domain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const newAccessToken = data.access_token as string;
    setAccessToken(newAccessToken);

    const user = extractUserFromToken(newAccessToken);
    if (user) setUserInfo(user);

    return newAccessToken;
  } catch {
    return null;
  }
}

// =============================================================================
// Authenticated Fetch (SWR-compatible)
// =============================================================================

/**
 * Creates a fetcher function for SWR that includes the Authorization header.
 * On 401 responses, redirects to /login.
 * On 503 responses, throws with a persistence error flag for retry banner display.
 */
export async function authFetcher<T>(url: string): Promise<T> {
  let token = getAccessToken();

  if (!token || isTokenExpired(token)) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    token = refreshed;
  }

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
  });

  if (response.status === 401) {
    clearTokens();
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  if (response.status === 503) {
    const error = new Error('Service temporarily unavailable');
    (error as Error & { status: number }).status = 503;
    throw error;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${response.status}`);
  }

  return response.json();
}

/**
 * Makes an authenticated API request (for mutations: POST, PUT, DELETE, PATCH).
 */
export async function authRequest<T>(
  url: string,
  options: RequestInit = {}
): Promise<T> {
  let token = getAccessToken();

  if (!token || isTokenExpired(token)) {
    const refreshed = await refreshAccessToken();
    if (!refreshed) {
      window.location.href = '/login';
      throw new Error('Authentication required');
    }
    token = refreshed;
  }

  const response = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...options.headers,
    },
  });

  if (response.status === 401) {
    clearTokens();
    window.location.href = '/login';
    throw new Error('Authentication required');
  }

  if (response.status === 503) {
    const error = new Error('Service temporarily unavailable');
    (error as Error & { status: number }).status = 503;
    throw error;
  }

  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error((body as { message?: string }).message ?? `Request failed: ${response.status}`);
  }

  return response.json();
}

// =============================================================================
// Pending Messages (localStorage offline queue) — Requirement 9.5
// =============================================================================

export function getPendingMessages(): PendingMessage[] {
  if (typeof window === 'undefined') return [];
  const stored = localStorage.getItem(PENDING_MESSAGES_KEY);
  if (!stored) return [];
  try {
    return JSON.parse(stored) as PendingMessage[];
  } catch {
    return [];
  }
}

export function addPendingMessage(message: PendingMessage): void {
  if (typeof window === 'undefined') return;
  const messages = getPendingMessages();
  messages.push(message);
  localStorage.setItem(PENDING_MESSAGES_KEY, JSON.stringify(messages));
}

export function removePendingMessage(messageId: string): void {
  if (typeof window === 'undefined') return;
  const messages = getPendingMessages().filter((m) => m.id !== messageId);
  localStorage.setItem(PENDING_MESSAGES_KEY, JSON.stringify(messages));
}

export function clearPendingMessages(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(PENDING_MESSAGES_KEY);
}
