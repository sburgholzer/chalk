import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 18: Admin-only team management
 *
 * For any user U attempting to invoke `inviteUser`, `removeUser`, `changeRole`,
 * or `listTeamMembers`: if U has role `admin` for the given team, the operation
 * SHALL proceed; if U has role `member` or does not belong to the team, the
 * operation SHALL return an error with kind `NOT_ADMIN`.
 *
 * **Validates: Requirements 10.12, 10.13**
 */

// Mock the AWS SDK (DynamoDB)
const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: mockSend }),
  },
  PutCommand: vi.fn((input) => ({ input })),
  GetCommand: vi.fn((input) => ({ input })),
  QueryCommand: vi.fn((input) => ({ input })),
}));

// Mock the Cognito service
vi.mock('@/services/cognito', () => ({
  adminCreateUser: vi.fn(() =>
    Promise.resolve({ ok: true, value: { userId: 'new-user-id', email: 'new@test.com' } })
  ),
  adminRemoveUserFromGroup: vi.fn(() =>
    Promise.resolve({ ok: true, value: undefined })
  ),
}));

import { inviteUser, removeUser, changeRole, listTeamMembers } from '@/lib/team-management';
import type { TeamId, UserId, TeamRole, TeamMemberItem } from '@/types/domain';

/**
 * Creates a mock TeamMemberItem for DynamoDB responses.
 */
function makeTeamMemberItem(
  teamId: string,
  userId: string,
  role: TeamRole,
  email: string = 'user@test.com'
): TeamMemberItem {
  return {
    PK: `TEAM#${teamId}`,
    SK: `MEMBER#${userId}`,
    entityType: 'TEAM_MEMBER',
    teamId,
    userId,
    email,
    role,
    status: 'active',
    invitedBy: 'admin-original',
    invitedAt: '2024-01-01T00:00:00.000Z',
  };
}

/**
 * Sets up DynamoDB mocks to return a specific role for the caller (or no item).
 * Also handles the secondary queries needed by the operations (e.g., query for existing members).
 */
function setupMocks(params: {
  callerTeamId: string;
  callerId: string;
  callerRole: TeamRole | 'none'; // 'none' means user is not in the team
  targetUserId?: string;
  targetRole?: TeamRole;
  adminCount?: number;
}) {
  const { callerTeamId, callerId, callerRole, targetUserId, targetRole, adminCount } = params;

  mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
    const input = command.input;

    // GetCommand - check for specific member (isTeamAdmin check or target lookup)
    if (input.Key) {
      const key = input.Key as { PK: string; SK: string };

      // Caller admin check
      if (key.PK === `TEAM#${callerTeamId}` && key.SK === `MEMBER#${callerId}`) {
        if (callerRole === 'none') {
          return Promise.resolve({ Item: undefined });
        }
        return Promise.resolve({
          Item: makeTeamMemberItem(callerTeamId, callerId, callerRole),
        });
      }

      // Target user lookup (for removeUser/changeRole)
      if (targetUserId && key.PK === `TEAM#${callerTeamId}` && key.SK === `MEMBER#${targetUserId}`) {
        if (targetRole) {
          return Promise.resolve({
            Item: makeTeamMemberItem(callerTeamId, targetUserId, targetRole, 'target@test.com'),
          });
        }
        return Promise.resolve({ Item: undefined });
      }

      return Promise.resolve({ Item: undefined });
    }

    // QueryCommand - list members (for duplicate check in inviteUser, countAdmins, listTeamMembers)
    if (input.KeyConditionExpression) {
      const items: TeamMemberItem[] = [];

      // Always include the caller if they are in the team
      if (callerRole !== 'none') {
        items.push(makeTeamMemberItem(callerTeamId, callerId, callerRole));
      }

      // Include target if specified
      if (targetUserId && targetRole) {
        items.push(makeTeamMemberItem(callerTeamId, targetUserId, targetRole, 'target@test.com'));
      }

      // Add extra admins if adminCount > what we have
      const currentAdminCount = items.filter((i) => i.role === 'admin').length;
      const needed = (adminCount ?? currentAdminCount) - currentAdminCount;
      for (let i = 0; i < needed; i++) {
        items.push(makeTeamMemberItem(callerTeamId, `extra-admin-${i}`, 'admin', `extra${i}@test.com`));
      }

      return Promise.resolve({ Items: items });
    }

    // PutCommand - succeed
    return Promise.resolve({});
  });
}

describe('Property 18: Admin-only team management', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('admin callers can successfully invoke inviteUser', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        fc.emailAddress(), // email to invite
        fc.constantFrom('admin', 'member') as fc.Arbitrary<TeamRole>, // role for invitee
        async (teamId, callerId, email, role) => {
          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole: 'admin',
            adminCount: 2,
          });

          const result = await inviteUser({
            email,
            role,
            teamId: teamId as TeamId,
            invitedBy: callerId as UserId,
          });

          // Admin caller should NOT get NOT_ADMIN error
          if (!result.ok) {
            expect(result.error.kind).not.toBe('NOT_ADMIN');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-admin callers receive NOT_ADMIN error from inviteUser', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (non-admin)
        fc.emailAddress(), // email to invite
        fc.constantFrom('member', 'none') as fc.Arbitrary<'member' | 'none'>, // caller is member or not in team
        async (teamId, callerId, email, callerRole) => {
          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole,
          });

          const result = await inviteUser({
            email,
            role: 'member',
            teamId: teamId as TeamId,
            invitedBy: callerId as UserId,
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('NOT_ADMIN');
            expect(result.error).toHaveProperty('userId', callerId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('admin callers can successfully invoke removeUser', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        fc.uuid(), // targetUserId (member to remove)
        async (teamId, callerId, targetUserId) => {
          // Ensure caller and target are different
          fc.pre(callerId !== targetUserId);

          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole: 'admin',
            targetUserId,
            targetRole: 'member',
            adminCount: 2,
          });

          const result = await removeUser({
            userId: targetUserId as UserId,
            teamId: teamId as TeamId,
            removedBy: callerId as UserId,
          });

          // Admin caller should NOT get NOT_ADMIN error
          if (!result.ok) {
            expect(result.error.kind).not.toBe('NOT_ADMIN');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-admin callers receive NOT_ADMIN error from removeUser', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (non-admin)
        fc.uuid(), // targetUserId
        fc.constantFrom('member', 'none') as fc.Arbitrary<'member' | 'none'>,
        async (teamId, callerId, targetUserId, callerRole) => {
          fc.pre(callerId !== targetUserId);

          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole,
            targetUserId,
            targetRole: 'member',
          });

          const result = await removeUser({
            userId: targetUserId as UserId,
            teamId: teamId as TeamId,
            removedBy: callerId as UserId,
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('NOT_ADMIN');
            expect(result.error).toHaveProperty('userId', callerId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('admin callers can successfully invoke changeRole', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        fc.uuid(), // targetUserId
        fc.constantFrom('admin', 'member') as fc.Arbitrary<TeamRole>, // new role
        async (teamId, callerId, targetUserId, newRole) => {
          fc.pre(callerId !== targetUserId);

          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole: 'admin',
            targetUserId,
            targetRole: 'member', // target is a member being promoted/kept
            adminCount: 2,
          });

          const result = await changeRole({
            userId: targetUserId as UserId,
            teamId: teamId as TeamId,
            newRole,
            changedBy: callerId as UserId,
          });

          // Admin caller should NOT get NOT_ADMIN error
          if (!result.ok) {
            expect(result.error.kind).not.toBe('NOT_ADMIN');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-admin callers receive NOT_ADMIN error from changeRole', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (non-admin)
        fc.uuid(), // targetUserId
        fc.constantFrom('member', 'none') as fc.Arbitrary<'member' | 'none'>,
        async (teamId, callerId, targetUserId, callerRole) => {
          fc.pre(callerId !== targetUserId);

          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole,
            targetUserId,
            targetRole: 'member',
          });

          const result = await changeRole({
            userId: targetUserId as UserId,
            teamId: teamId as TeamId,
            newRole: 'admin',
            changedBy: callerId as UserId,
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('NOT_ADMIN');
            expect(result.error).toHaveProperty('userId', callerId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('admin callers can successfully invoke listTeamMembers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        async (teamId, callerId) => {
          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole: 'admin',
            adminCount: 1,
          });

          const result = await listTeamMembers({
            teamId: teamId as TeamId,
            requestedBy: callerId as UserId,
          });

          // Admin caller should NOT get NOT_ADMIN error
          if (!result.ok) {
            expect(result.error.kind).not.toBe('NOT_ADMIN');
          }
          // Should succeed for admin
          expect(result.ok).toBe(true);
          if (result.ok) {
            expect(Array.isArray(result.value)).toBe(true);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('non-admin callers receive NOT_ADMIN error from listTeamMembers', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (non-admin)
        fc.constantFrom('member', 'none') as fc.Arbitrary<'member' | 'none'>,
        async (teamId, callerId, callerRole) => {
          mockSend.mockReset();
          setupMocks({
            callerTeamId: teamId,
            callerId,
            callerRole,
          });

          const result = await listTeamMembers({
            teamId: teamId as TeamId,
            requestedBy: callerId as UserId,
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('NOT_ADMIN');
            expect(result.error).toHaveProperty('userId', callerId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 19: Cannot remove last admin
 *
 * For any team T with exactly one user with role `admin`, attempting to remove
 * that user or demote them to `member` SHALL return an error with kind
 * `CANNOT_REMOVE_LAST_ADMIN`. The team SHALL always retain at least one admin.
 *
 * When there are 2+ admins, removing or demoting one admin should NOT return
 * CANNOT_REMOVE_LAST_ADMIN.
 *
 * **Validates: Requirements 10.10, 10.11**
 */
describe('Property 19: Cannot remove last admin', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  /**
   * Helper: sets up mocks where the team has exactly one admin (the target)
   * and the caller is also that admin (self-removal/demotion) OR a separate admin.
   * For the "sole admin" scenario, we make the caller the same person as the target
   * since the caller must be an admin to pass the NOT_ADMIN check.
   */
  function setupSoleAdminMocks(params: {
    teamId: string;
    adminUserId: string;
  }) {
    const { teamId, adminUserId } = params;

    mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
      const input = command.input;

      // GetCommand - lookup specific member
      if (input.Key) {
        const key = input.Key as { PK: string; SK: string };

        if (key.PK === `TEAM#${teamId}` && key.SK === `MEMBER#${adminUserId}`) {
          return Promise.resolve({
            Item: makeTeamMemberItem(teamId, adminUserId, 'admin', 'admin@test.com'),
          });
        }

        return Promise.resolve({ Item: undefined });
      }

      // QueryCommand - return only the one admin (sole admin scenario)
      if (input.KeyConditionExpression) {
        return Promise.resolve({
          Items: [makeTeamMemberItem(teamId, adminUserId, 'admin', 'admin@test.com')],
        });
      }

      // PutCommand - succeed
      return Promise.resolve({});
    });
  }

  /**
   * Helper: sets up mocks where the team has multiple admins.
   * The caller is one admin, and the target is another admin.
   */
  function setupMultipleAdminMocks(params: {
    teamId: string;
    callerId: string;
    targetAdminId: string;
    extraAdminCount?: number;
  }) {
    const { teamId, callerId, targetAdminId, extraAdminCount = 0 } = params;

    mockSend.mockImplementation((command: { input: Record<string, unknown> }) => {
      const input = command.input;

      // GetCommand - lookup specific member
      if (input.Key) {
        const key = input.Key as { PK: string; SK: string };

        if (key.PK === `TEAM#${teamId}` && key.SK === `MEMBER#${callerId}`) {
          return Promise.resolve({
            Item: makeTeamMemberItem(teamId, callerId, 'admin', 'caller@test.com'),
          });
        }

        if (key.PK === `TEAM#${teamId}` && key.SK === `MEMBER#${targetAdminId}`) {
          return Promise.resolve({
            Item: makeTeamMemberItem(teamId, targetAdminId, 'admin', 'target@test.com'),
          });
        }

        return Promise.resolve({ Item: undefined });
      }

      // QueryCommand - return multiple admins
      if (input.KeyConditionExpression) {
        const items: TeamMemberItem[] = [
          makeTeamMemberItem(teamId, callerId, 'admin', 'caller@test.com'),
          makeTeamMemberItem(teamId, targetAdminId, 'admin', 'target@test.com'),
        ];

        for (let i = 0; i < extraAdminCount; i++) {
          items.push(makeTeamMemberItem(teamId, `extra-admin-${i}`, 'admin', `extra${i}@test.com`));
        }

        return Promise.resolve({ Items: items });
      }

      // PutCommand - succeed
      return Promise.resolve({});
    });
  }

  it('removeUser returns CANNOT_REMOVE_LAST_ADMIN when team has exactly one admin', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // sole admin userId
        async (teamId, adminUserId) => {
          mockSend.mockReset();
          setupSoleAdminMocks({ teamId, adminUserId });

          const result = await removeUser({
            userId: adminUserId as UserId,
            teamId: teamId as TeamId,
            removedBy: adminUserId as UserId, // admin removing themselves
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('CANNOT_REMOVE_LAST_ADMIN');
            expect(result.error).toHaveProperty('teamId', teamId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('changeRole returns CANNOT_REMOVE_LAST_ADMIN when demoting the sole admin to member', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // sole admin userId
        async (teamId, adminUserId) => {
          mockSend.mockReset();
          setupSoleAdminMocks({ teamId, adminUserId });

          const result = await changeRole({
            userId: adminUserId as UserId,
            teamId: teamId as TeamId,
            newRole: 'member',
            changedBy: adminUserId as UserId, // admin demoting themselves
          });

          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('CANNOT_REMOVE_LAST_ADMIN');
            expect(result.error).toHaveProperty('teamId', teamId);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('removeUser succeeds (no CANNOT_REMOVE_LAST_ADMIN) when team has 2+ admins', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        fc.uuid(), // targetAdminId (admin to remove)
        fc.nat({ max: 3 }), // extra admins beyond the two
        async (teamId, callerId, targetAdminId, extraAdminCount) => {
          fc.pre(callerId !== targetAdminId);

          mockSend.mockReset();
          setupMultipleAdminMocks({ teamId, callerId, targetAdminId, extraAdminCount });

          const result = await removeUser({
            userId: targetAdminId as UserId,
            teamId: teamId as TeamId,
            removedBy: callerId as UserId,
          });

          // Should NOT return CANNOT_REMOVE_LAST_ADMIN since there are 2+ admins
          if (!result.ok) {
            expect(result.error.kind).not.toBe('CANNOT_REMOVE_LAST_ADMIN');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('changeRole succeeds (no CANNOT_REMOVE_LAST_ADMIN) when demoting an admin and team has 2+ admins', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // teamId
        fc.uuid(), // callerId (admin)
        fc.uuid(), // targetAdminId (admin being demoted)
        fc.nat({ max: 3 }), // extra admins beyond the two
        async (teamId, callerId, targetAdminId, extraAdminCount) => {
          fc.pre(callerId !== targetAdminId);

          mockSend.mockReset();
          setupMultipleAdminMocks({ teamId, callerId, targetAdminId, extraAdminCount });

          const result = await changeRole({
            userId: targetAdminId as UserId,
            teamId: teamId as TeamId,
            newRole: 'member',
            changedBy: callerId as UserId,
          });

          // Should NOT return CANNOT_REMOVE_LAST_ADMIN since there are 2+ admins
          if (!result.ok) {
            expect(result.error.kind).not.toBe('CANNOT_REMOVE_LAST_ADMIN');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
