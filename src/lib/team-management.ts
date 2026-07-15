import { Result, ok, err } from '@/types/result';
import {
  TeamId,
  UserId,
  TeamRole,
  UserStatus,
  TeamMember,
  TeamMemberItem,
} from '@/types/domain';
import { putItem, getItem, query } from '@/services/dynamo';
import {
  adminCreateUser,
  adminRemoveUserFromGroup,
} from '@/services/cognito';

// =============================================================================
// Error Types
// =============================================================================

export type TeamManagementError =
  | { kind: 'NOT_ADMIN'; userId: UserId }
  | { kind: 'USER_ALREADY_EXISTS'; email: string }
  | { kind: 'USER_NOT_FOUND'; userId: UserId }
  | { kind: 'CANNOT_REMOVE_LAST_ADMIN'; teamId: TeamId }
  | { kind: 'COGNITO_FAILURE'; cause: string }
  | { kind: 'PERSISTENCE_FAILURE'; cause: string };

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Checks if a user has admin role for the given team.
 * Queries the DynamoDB TeamMemberItem and checks role === 'admin'.
 *
 * Requirements: 10.12, 10.13
 */
export async function isTeamAdmin(
  userId: UserId,
  teamId: TeamId
): Promise<boolean> {
  const result = await getItem<TeamMemberItem>({
    pk: `TEAM#${teamId}`,
    sk: `MEMBER#${userId}`,
  });

  if (!result.ok || !result.value) {
    return false;
  }

  return result.value.role === 'admin' && result.value.status !== 'disabled';
}

/**
 * Invites a new user to the team.
 * Creates Cognito user via AdminCreateUser, assigns to team group,
 * stores role in DynamoDB TeamMemberItem, sends invitation email with temporary password.
 *
 * Requirements: 10.2, 10.9
 */
export async function inviteUser(params: {
  email: string;
  role: TeamRole;
  teamId: TeamId;
  invitedBy: UserId;
}): Promise<Result<TeamMember, TeamManagementError>> {
  // Check that the inviter is an admin
  const inviterIsAdmin = await isTeamAdmin(params.invitedBy, params.teamId);
  if (!inviterIsAdmin) {
    return err({ kind: 'NOT_ADMIN', userId: params.invitedBy });
  }

  // Check if user already exists in this team (by email)
  const existingMembersResult = await query<TeamMemberItem>({
    pk: `TEAM#${params.teamId}`,
    skPrefix: 'MEMBER#',
  });

  if (!existingMembersResult.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to check existing members' });
  }

  const existingMember = existingMembersResult.value.find(
    (member) => member.email === params.email && member.status !== 'disabled'
  );

  if (existingMember) {
    return err({ kind: 'USER_ALREADY_EXISTS', email: params.email });
  }

  // Create the Cognito user and add to team group (sends invitation email)
  const cognitoResult = await adminCreateUser({
    email: params.email,
    teamId: params.teamId,
  });

  if (!cognitoResult.ok) {
    const cause = cognitoResult.error.kind === 'SERVICE_FAILURE'
      ? cognitoResult.error.cause
      : 'Cognito operation failed';
    return err({ kind: 'COGNITO_FAILURE', cause });
  }

  const { userId } = cognitoResult.value;

  // Store the team member record in DynamoDB
  const now = new Date().toISOString();
  const teamMemberItem: TeamMemberItem & Record<string, unknown> = {
    PK: `TEAM#${params.teamId}`,
    SK: `MEMBER#${userId}`,
    entityType: 'TEAM_MEMBER',
    teamId: params.teamId,
    userId,
    email: params.email,
    role: params.role,
    status: 'invited' as UserStatus,
    invitedBy: params.invitedBy,
    invitedAt: now,
  };

  const writeResult = await putItem({ item: teamMemberItem });

  if (!writeResult.ok) {
    const cause =
      writeResult.error.kind === 'WRITE_FAILURE'
        ? writeResult.error.cause
        : writeResult.error.kind === 'CONDITION_CHECK_FAILED'
          ? writeResult.error.message
          : 'Unknown persistence error';
    return err({ kind: 'PERSISTENCE_FAILURE', cause });
  }

  const teamMember: TeamMember = {
    userId: userId as UserId,
    email: params.email,
    role: params.role,
    status: 'invited',
    invitedAt: now,
    invitedBy: params.invitedBy,
  };

  return ok(teamMember);
}

/**
 * Removes a user from the team.
 * Removes from Cognito group, revokes room access, marks as disabled in DynamoDB.
 *
 * Requirements: 10.10
 */
export async function removeUser(params: {
  userId: UserId;
  teamId: TeamId;
  removedBy: UserId;
}): Promise<Result<void, TeamManagementError>> {
  // Check that the remover is an admin
  const removerIsAdmin = await isTeamAdmin(params.removedBy, params.teamId);
  if (!removerIsAdmin) {
    return err({ kind: 'NOT_ADMIN', userId: params.removedBy });
  }

  // Get the member to be removed
  const memberResult = await getItem<TeamMemberItem>({
    pk: `TEAM#${params.teamId}`,
    sk: `MEMBER#${params.userId}`,
  });

  if (!memberResult.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to retrieve member' });
  }

  if (!memberResult.value) {
    return err({ kind: 'USER_NOT_FOUND', userId: params.userId });
  }

  const member = memberResult.value;

  // Enforce cannot-remove-last-admin guard
  if (member.role === 'admin') {
    const adminCountResult = await countAdmins(params.teamId);
    if (!adminCountResult.ok) {
      return err(adminCountResult.error);
    }
    if (adminCountResult.value <= 1) {
      return err({ kind: 'CANNOT_REMOVE_LAST_ADMIN', teamId: params.teamId });
    }
  }

  // Remove from Cognito group (revokes room access on next token refresh)
  const removeGroupResult = await adminRemoveUserFromGroup({
    userId: member.email,
    teamId: params.teamId,
  });

  if (!removeGroupResult.ok) {
    const cause = removeGroupResult.error.kind === 'SERVICE_FAILURE'
      ? removeGroupResult.error.cause
      : 'Cognito operation failed';
    return err({ kind: 'COGNITO_FAILURE', cause });
  }

  // Mark as disabled in DynamoDB
  const disabledItem: TeamMemberItem & Record<string, unknown> = {
    ...member,
    PK: `TEAM#${params.teamId}`,
    SK: `MEMBER#${params.userId}`,
    status: 'disabled' as UserStatus,
  };

  const writeResult = await putItem({ item: disabledItem });

  if (!writeResult.ok) {
    const cause =
      writeResult.error.kind === 'WRITE_FAILURE'
        ? writeResult.error.cause
        : 'Unknown persistence error';
    return err({ kind: 'PERSISTENCE_FAILURE', cause });
  }

  return ok(undefined);
}

/**
 * Changes a user's role between admin and member.
 * Enforces cannot-remove-last-admin guard when demoting.
 *
 * Requirements: 10.11
 */
export async function changeRole(params: {
  userId: UserId;
  teamId: TeamId;
  newRole: TeamRole;
  changedBy: UserId;
}): Promise<Result<TeamMember, TeamManagementError>> {
  // Check that the changer is an admin
  const changerIsAdmin = await isTeamAdmin(params.changedBy, params.teamId);
  if (!changerIsAdmin) {
    return err({ kind: 'NOT_ADMIN', userId: params.changedBy });
  }

  // Get the target member
  const memberResult = await getItem<TeamMemberItem>({
    pk: `TEAM#${params.teamId}`,
    sk: `MEMBER#${params.userId}`,
  });

  if (!memberResult.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to retrieve member' });
  }

  if (!memberResult.value) {
    return err({ kind: 'USER_NOT_FOUND', userId: params.userId });
  }

  const member = memberResult.value;

  // Enforce cannot-remove-last-admin when demoting an admin to member
  if (member.role === 'admin' && params.newRole === 'member') {
    const adminCountResult = await countAdmins(params.teamId);
    if (!adminCountResult.ok) {
      return err(adminCountResult.error);
    }
    if (adminCountResult.value <= 1) {
      return err({ kind: 'CANNOT_REMOVE_LAST_ADMIN', teamId: params.teamId });
    }
  }

  // Update the role in DynamoDB
  const updatedItem: TeamMemberItem & Record<string, unknown> = {
    ...member,
    PK: `TEAM#${params.teamId}`,
    SK: `MEMBER#${params.userId}`,
    role: params.newRole,
  };

  const writeResult = await putItem({ item: updatedItem });

  if (!writeResult.ok) {
    const cause =
      writeResult.error.kind === 'WRITE_FAILURE'
        ? writeResult.error.cause
        : 'Unknown persistence error';
    return err({ kind: 'PERSISTENCE_FAILURE', cause });
  }

  const updatedMember: TeamMember = {
    userId: member.userId as UserId,
    email: member.email,
    role: params.newRole,
    status: member.status,
    invitedAt: member.invitedAt,
    invitedBy: member.invitedBy as UserId,
    lastActiveAt: member.lastActiveAt,
  };

  return ok(updatedMember);
}

/**
 * Lists all team members with email, role, and status.
 * Queries DynamoDB for all MEMBER# items in the team partition.
 *
 * Requirements: 10.8
 */
export async function listTeamMembers(params: {
  teamId: TeamId;
  requestedBy: UserId;
}): Promise<Result<TeamMember[], TeamManagementError>> {
  // Check that the requester is an admin
  const requesterIsAdmin = await isTeamAdmin(params.requestedBy, params.teamId);
  if (!requesterIsAdmin) {
    return err({ kind: 'NOT_ADMIN', userId: params.requestedBy });
  }

  const result = await query<TeamMemberItem>({
    pk: `TEAM#${params.teamId}`,
    skPrefix: 'MEMBER#',
  });

  if (!result.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to query team members' });
  }

  const members: TeamMember[] = result.value.map((item) => ({
    userId: item.userId as UserId,
    email: item.email,
    role: item.role,
    status: item.status,
    invitedAt: item.invitedAt,
    invitedBy: item.invitedBy as UserId,
    lastActiveAt: item.lastActiveAt,
  }));

  return ok(members);
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Counts the number of active admins in a team.
 * Used to enforce the cannot-remove-last-admin guard.
 */
async function countAdmins(
  teamId: TeamId
): Promise<Result<number, TeamManagementError>> {
  const result = await query<TeamMemberItem>({
    pk: `TEAM#${teamId}`,
    skPrefix: 'MEMBER#',
  });

  if (!result.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to count admins' });
  }

  const adminCount = result.value.filter(
    (member) => member.role === 'admin' && member.status !== 'disabled'
  ).length;

  return ok(adminCount);
}
