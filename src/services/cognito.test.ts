import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CognitoError, CognitoUser } from '@/services/cognito';

// Mock the AWS SDK
const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-cognito-identity-provider', () => ({
  CognitoIdentityProviderClient: vi.fn(() => ({ send: mockSend })),
  AdminCreateUserCommand: vi.fn((input) => ({ input })),
  AdminAddUserToGroupCommand: vi.fn((input) => ({ input })),
  AdminRemoveUserFromGroupCommand: vi.fn((input) => ({ input })),
  AdminListGroupsForUserCommand: vi.fn((input) => ({ input })),
  AdminGetUserCommand: vi.fn((input) => ({ input })),
  CreateGroupCommand: vi.fn((input) => ({ input })),
}));

// Mock fetch for JWKS
const mockFetch = vi.hoisted(() => vi.fn());
vi.stubGlobal('fetch', mockFetch);

// Set env vars before importing module
vi.stubEnv('COGNITO_USER_POOL_ID', 'us-east-1_TestPool');
vi.stubEnv('COGNITO_CLIENT_ID', 'test-client-id');
vi.stubEnv('COGNITO_REGION', 'us-east-1');

import {
  validateToken,
  extractUserIdentity,
  getUserTeams,
  isUserInTeam,
  isUserInTeamFromClaims,
  authorize,
  adminCreateUser,
  adminAddUserToGroup,
  adminRemoveUserFromGroup,
  adminGetUser,
  adminCreateGroup,
  clearJWKSCache,
  resetClient,
} from '@/services/cognito';
import type { UserId, TeamId } from '@/types/domain';

// =============================================================================
// Helpers
// =============================================================================

function createJWT(payload: Record<string, unknown>, header?: Record<string, unknown>): string {
  const h = header ?? { kid: 'test-kid-1', alg: 'RS256' };
  const headerB64 = Buffer.from(JSON.stringify(h)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = Buffer.from('fake-signature').toString('base64url');
  return `${headerB64}.${payloadB64}.${signature}`;
}

function createValidPayload(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
  return {
    sub: 'user-123',
    email: 'test@example.com',
    'cognito:groups': ['team-alpha', 'team-beta'],
    'cognito:username': 'test@example.com',
    token_use: 'access',
    exp: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    iat: Math.floor(Date.now() / 1000),
    iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_TestPool',
    client_id: 'test-client-id',
    ...overrides,
  };
}

function mockJWKSResponse(): void {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({
      keys: [
        { kid: 'test-kid-1', alg: 'RS256', kty: 'RSA', e: 'AQAB', n: 'test-n', use: 'sig' },
        { kid: 'test-kid-2', alg: 'RS256', kty: 'RSA', e: 'AQAB', n: 'test-n-2', use: 'sig' },
      ],
    }),
  });
}

// =============================================================================
// Tests
// =============================================================================

describe('Cognito Service', () => {
  beforeEach(() => {
    mockSend.mockReset();
    mockFetch.mockReset();
    clearJWKSCache();
    resetClient();
  });

  describe('validateToken', () => {
    it('returns CognitoUser for a valid token', async () => {
      mockJWKSResponse();
      const token = createJWT(createValidPayload());

      const result = await validateToken(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('user-123');
        expect(result.value.email).toBe('test@example.com');
        expect(result.value.teams).toEqual(['team-alpha', 'team-beta']);
      }
    });

    it('returns TOKEN_INVALID for malformed token', async () => {
      const result = await validateToken('not-a-jwt');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
      }
    });

    it('returns TOKEN_INVALID for token with only 2 parts', async () => {
      const result = await validateToken('part1.part2');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('3 parts');
      }
    });

    it('returns TOKEN_EXPIRED for expired token', async () => {
      mockJWKSResponse();
      const expiredPayload = createValidPayload({
        exp: Math.floor(Date.now() / 1000) - 3600, // 1 hour ago
      });
      const token = createJWT(expiredPayload);

      const result = await validateToken(token);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_EXPIRED');
      }
    });

    it('returns TOKEN_INVALID for wrong issuer', async () => {
      const payload = createValidPayload({
        iss: 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_WrongPool',
      });
      const token = createJWT(payload);

      const result = await validateToken(token);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('Invalid issuer');
      }
    });

    it('returns TOKEN_INVALID for non-access token', async () => {
      const payload = createValidPayload({ token_use: 'id' });
      const token = createJWT(payload);

      const result = await validateToken(token);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('token_use');
      }
    });

    it('returns TOKEN_INVALID when kid does not match any JWKS key', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          keys: [
            { kid: 'other-kid', alg: 'RS256', kty: 'RSA', e: 'AQAB', n: 'test-n', use: 'sig' },
          ],
        }),
      });

      const token = createJWT(createValidPayload());

      const result = await validateToken(token);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('No matching key');
      }
    });

    it('returns SERVICE_FAILURE when JWKS fetch fails', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const token = createJWT(createValidPayload());

      const result = await validateToken(token);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('SERVICE_FAILURE');
      }
    });

    it('uses cached JWKS on subsequent calls', async () => {
      mockJWKSResponse();
      const token = createJWT(createValidPayload());

      await validateToken(token);
      await validateToken(token);

      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('handles token with no groups gracefully', async () => {
      mockJWKSResponse();
      const payload = createValidPayload({ 'cognito:groups': undefined });
      const token = createJWT(payload);

      const result = await validateToken(token);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.teams).toEqual([]);
      }
    });
  });

  describe('extractUserIdentity', () => {
    it('returns CognitoUser from valid Bearer token', async () => {
      mockJWKSResponse();
      const token = createJWT(createValidPayload());

      const result = await extractUserIdentity(`Bearer ${token}`);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('user-123');
      }
    });

    it('returns TOKEN_INVALID when Authorization header is missing', async () => {
      const result = await extractUserIdentity(undefined);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('Missing Authorization');
      }
    });

    it('returns TOKEN_INVALID when not Bearer scheme', async () => {
      const result = await extractUserIdentity('Basic dXNlcjpwYXNz');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
        expect(result.error.message).toContain('Bearer');
      }
    });

    it('returns TOKEN_INVALID for empty header', async () => {
      const result = await extractUserIdentity('');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('TOKEN_INVALID');
      }
    });
  });

  describe('getUserTeams', () => {
    it('returns list of team IDs from Cognito groups', async () => {
      mockSend.mockResolvedValueOnce({
        Groups: [
          { GroupName: 'team-alpha' },
          { GroupName: 'team-beta' },
        ],
      });

      const result = await getUserTeams('user-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual(['team-alpha', 'team-beta']);
      }
    });

    it('returns empty array when user has no groups', async () => {
      mockSend.mockResolvedValueOnce({ Groups: [] });

      const result = await getUserTeams('user-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('returns USER_NOT_FOUND when user does not exist', async () => {
      const error = new Error('User not found');
      error.name = 'UserNotFoundException';
      mockSend.mockRejectedValueOnce(error);

      const result = await getUserTeams('nonexistent-user');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('USER_NOT_FOUND');
        expect((result.error as Extract<CognitoError, { kind: 'USER_NOT_FOUND' }>).userId).toBe('nonexistent-user');
      }
    });

    it('returns SERVICE_FAILURE on Cognito error', async () => {
      mockSend.mockRejectedValueOnce(new Error('Service unavailable'));

      const result = await getUserTeams('user-123');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('SERVICE_FAILURE');
      }
    });
  });

  describe('isUserInTeam', () => {
    it('returns true when user is in team', async () => {
      mockSend.mockResolvedValueOnce({
        Groups: [{ GroupName: 'team-alpha' }],
      });

      const result = await isUserInTeam('user-123', 'team-alpha' as TeamId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('returns false when user is not in team', async () => {
      mockSend.mockResolvedValueOnce({
        Groups: [{ GroupName: 'team-beta' }],
      });

      const result = await isUserInTeam('user-123', 'team-alpha' as TeamId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(false);
      }
    });
  });

  describe('isUserInTeamFromClaims', () => {
    it('returns true when team is in user claims', () => {
      const user: CognitoUser = {
        userId: 'user-123' as UserId,
        email: 'test@example.com',
        teams: ['team-alpha' as TeamId, 'team-beta' as TeamId],
        tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
      };

      expect(isUserInTeamFromClaims(user, 'team-alpha' as TeamId)).toBe(true);
    });

    it('returns false when team is not in user claims', () => {
      const user: CognitoUser = {
        userId: 'user-123' as UserId,
        email: 'test@example.com',
        teams: ['team-beta' as TeamId],
        tokenExpiry: Math.floor(Date.now() / 1000) + 3600,
      };

      expect(isUserInTeamFromClaims(user, 'team-alpha' as TeamId)).toBe(false);
    });
  });

  describe('authorize', () => {
    it('returns isAuthorized=true with context for valid token', async () => {
      mockJWKSResponse();
      const token = createJWT(createValidPayload());

      const result = await authorize({
        headers: { authorization: `Bearer ${token}` },
      });

      expect(result.isAuthorized).toBe(true);
      expect(result.context?.userId).toBe('user-123');
      expect(result.context?.email).toBe('test@example.com');
      expect(JSON.parse(result.context?.teams ?? '[]')).toEqual(['team-alpha', 'team-beta']);
    });

    it('returns isAuthorized=false for missing auth header', async () => {
      const result = await authorize({ headers: {} });

      expect(result.isAuthorized).toBe(false);
      expect(result.context).toBeUndefined();
    });

    it('returns isAuthorized=false for invalid token', async () => {
      const result = await authorize({
        headers: { authorization: 'Bearer invalid-token' },
      });

      expect(result.isAuthorized).toBe(false);
    });

    it('handles Authorization header with capital A', async () => {
      mockJWKSResponse();
      const token = createJWT(createValidPayload());

      const result = await authorize({
        headers: { Authorization: `Bearer ${token}` },
      });

      expect(result.isAuthorized).toBe(true);
    });
  });

  describe('adminCreateUser', () => {
    it('creates user and adds to group on success', async () => {
      mockSend
        .mockResolvedValueOnce({
          User: { Username: 'new-user-id' },
        })
        .mockResolvedValueOnce({});

      const result = await adminCreateUser({
        email: 'new@example.com',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.userId).toBe('new-user-id');
        expect(result.value.email).toBe('new@example.com');
      }
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns SERVICE_FAILURE on Cognito error', async () => {
      mockSend.mockRejectedValueOnce(new Error('User already exists'));

      const result = await adminCreateUser({
        email: 'existing@example.com',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('SERVICE_FAILURE');
      }
    });
  });

  describe('adminAddUserToGroup', () => {
    it('adds user to group successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await adminAddUserToGroup({
        userId: 'user-123',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(true);
    });

    it('returns USER_NOT_FOUND for nonexistent user', async () => {
      const error = new Error('User not found');
      error.name = 'UserNotFoundException';
      mockSend.mockRejectedValueOnce(error);

      const result = await adminAddUserToGroup({
        userId: 'nonexistent',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('USER_NOT_FOUND');
      }
    });
  });

  describe('adminRemoveUserFromGroup', () => {
    it('removes user from group successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await adminRemoveUserFromGroup({
        userId: 'user-123',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(true);
    });

    it('returns USER_NOT_FOUND for nonexistent user', async () => {
      const error = new Error('User not found');
      error.name = 'UserNotFoundException';
      mockSend.mockRejectedValueOnce(error);

      const result = await adminRemoveUserFromGroup({
        userId: 'nonexistent',
        teamId: 'team-alpha' as TeamId,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('USER_NOT_FOUND');
      }
    });
  });

  describe('adminGetUser', () => {
    it('returns user details on success', async () => {
      mockSend.mockResolvedValueOnce({
        UserAttributes: [
          { Name: 'email', Value: 'user@example.com' },
          { Name: 'sub', Value: 'user-123' },
        ],
        UserStatus: 'CONFIRMED',
      });

      const result = await adminGetUser('user-123');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.email).toBe('user@example.com');
        expect(result.value.status).toBe('CONFIRMED');
      }
    });

    it('returns USER_NOT_FOUND for nonexistent user', async () => {
      const error = new Error('User not found');
      error.name = 'UserNotFoundException';
      mockSend.mockRejectedValueOnce(error);

      const result = await adminGetUser('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('USER_NOT_FOUND');
      }
    });
  });

  describe('adminCreateGroup', () => {
    it('creates a group successfully', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await adminCreateGroup('team-new' as TeamId);

      expect(result.ok).toBe(true);
    });

    it('returns SERVICE_FAILURE on error', async () => {
      mockSend.mockRejectedValueOnce(new Error('Group already exists'));

      const result = await adminCreateGroup('team-existing' as TeamId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('SERVICE_FAILURE');
      }
    });
  });
});
