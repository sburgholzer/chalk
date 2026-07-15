/**
 * Lambda handlers for Team Management operations.
 *
 * Endpoints:
 * - GET /teams/:id/members — List team members (admin only)
 * - POST /teams/:id/members — Invite user with email and role (admin only)
 * - DELETE /teams/:id/members/:userId — Remove user from team (admin only)
 * - PATCH /teams/:id/members/:userId — Change user role (admin only)
 *
 * All endpoints enforce admin-only access via `isTeamAdmin` check.
 * Domain errors are mapped to appropriate HTTP status codes.
 *
 * Requirements: 10.8, 10.9, 10.10, 10.11, 10.12, 10.13
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  isTeamAdmin,
  listTeamMembers,
  inviteUser,
  removeUser,
  changeRole,
  type TeamManagementError,
} from '@/lib/team-management';
import type { TeamId, UserId, TeamRole } from '@/types/domain';

// =============================================================================
// Types
// =============================================================================

/** Context injected by the API Gateway Cognito authorizer. */
interface AuthorizerContext {
  userId: string;
  email: string;
  teams: string; // JSON-encoded string array of TeamId
}

/** Request body for POST /teams/:id/members (invite user). */
interface InviteRequest {
  email: string;
  role: TeamRole;
}

/** Request body for PATCH /teams/:id/members/:userId (change role). */
interface ChangeRoleRequest {
  role: TeamRole;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the authorizer context from the API Gateway event.
 */
function extractAuthContext(event: APIGatewayProxyEventV2): AuthorizerContext | null {
  const context = (event.requestContext as unknown as { authorizer?: { lambda?: AuthorizerContext } })
    ?.authorizer?.lambda;

  if (!context?.userId || !context?.teams) {
    return null;
  }

  return context;
}

/**
 * Creates a standard JSON response.
 */
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Extracts a path parameter from the event.
 */
function getPathParam(event: APIGatewayProxyEventV2, paramName: string): string | undefined {
  return event.pathParameters?.[paramName];
}

/**
 * Maps a TeamManagementError to the appropriate HTTP status code and response body.
 */
function mapTeamErrorToResponse(error: TeamManagementError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'NOT_ADMIN':
      return jsonResponse(403, {
        error: 'Forbidden: admin access required',
        userId: error.userId,
      });
    case 'USER_ALREADY_EXISTS':
      return jsonResponse(409, {
        error: 'User already exists in this team',
        email: error.email,
      });
    case 'USER_NOT_FOUND':
      return jsonResponse(404, {
        error: 'User not found',
        userId: error.userId,
      });
    case 'CANNOT_REMOVE_LAST_ADMIN':
      return jsonResponse(400, {
        error: 'Cannot remove or demote the last admin of the team',
        teamId: error.teamId,
      });
    case 'COGNITO_FAILURE':
      return jsonResponse(503, {
        error: 'Authentication service temporarily unavailable',
        detail: error.cause,
      });
    case 'PERSISTENCE_FAILURE':
      return jsonResponse(503, {
        error: 'Service temporarily unavailable. Please retry.',
        detail: error.cause,
      });
  }
}

/**
 * Validates that the requesting user is an admin of the specified team.
 * Returns a 403 response if not admin, or null if admin check passes.
 */
async function enforceAdmin(
  userId: string,
  teamId: TeamId
): Promise<APIGatewayProxyResultV2 | null> {
  const admin = await isTeamAdmin(userId as UserId, teamId);
  if (!admin) {
    return jsonResponse(403, {
      error: 'Forbidden: admin access required',
    });
  }
  return null;
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * GET /teams/:id/members — List all members of a team.
 *
 * Admin-only endpoint. Returns all team members with email, role, and status.
 *
 * Requirements: 10.8, 10.12, 10.13
 */
async function handleListMembers(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = getPathParam(event, 'id') as TeamId | undefined;
  if (!teamId) {
    return jsonResponse(400, { error: 'Missing team ID' });
  }

  // Enforce admin-only access
  const adminCheck = await enforceAdmin(authContext.userId, teamId);
  if (adminCheck) return adminCheck;

  const result = await listTeamMembers({
    teamId,
    requestedBy: authContext.userId as UserId,
  });

  if (!result.ok) {
    return mapTeamErrorToResponse(result.error);
  }

  return jsonResponse(200, { members: result.value });
}

/**
 * POST /teams/:id/members — Invite a new user to the team.
 *
 * Request body: { email: string, role: "admin" | "member" }
 *
 * Admin-only endpoint. Creates Cognito user, assigns to team group,
 * stores role in DynamoDB, and sends invitation email.
 *
 * Requirements: 10.9, 10.12, 10.13
 */
async function handleInviteUser(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = getPathParam(event, 'id') as TeamId | undefined;
  if (!teamId) {
    return jsonResponse(400, { error: 'Missing team ID' });
  }

  // Enforce admin-only access
  const adminCheck = await enforceAdmin(authContext.userId, teamId);
  if (adminCheck) return adminCheck;

  // Parse request body
  let body: InviteRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // Validate email
  if (!body.email || typeof body.email !== 'string' || body.email.trim().length === 0) {
    return jsonResponse(400, { error: 'Missing or empty required field: email' });
  }

  // Basic email format validation
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(body.email.trim())) {
    return jsonResponse(400, { error: 'Invalid email format' });
  }

  // Validate role
  const validRoles: TeamRole[] = ['admin', 'member'];
  if (!body.role || !validRoles.includes(body.role)) {
    return jsonResponse(400, {
      error: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
    });
  }

  const result = await inviteUser({
    email: body.email.trim(),
    role: body.role,
    teamId,
    invitedBy: authContext.userId as UserId,
  });

  if (!result.ok) {
    return mapTeamErrorToResponse(result.error);
  }

  return jsonResponse(201, result.value);
}

/**
 * DELETE /teams/:id/members/:userId — Remove a user from the team.
 *
 * Admin-only endpoint. Removes user from Cognito group, revokes room access,
 * and marks as disabled in DynamoDB.
 *
 * Requirements: 10.10, 10.12, 10.13
 */
async function handleRemoveUser(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = getPathParam(event, 'id') as TeamId | undefined;
  if (!teamId) {
    return jsonResponse(400, { error: 'Missing team ID' });
  }

  const targetUserId = getPathParam(event, 'userId') as UserId | undefined;
  if (!targetUserId) {
    return jsonResponse(400, { error: 'Missing user ID' });
  }

  // Enforce admin-only access
  const adminCheck = await enforceAdmin(authContext.userId, teamId);
  if (adminCheck) return adminCheck;

  const result = await removeUser({
    userId: targetUserId,
    teamId,
    removedBy: authContext.userId as UserId,
  });

  if (!result.ok) {
    return mapTeamErrorToResponse(result.error);
  }

  return jsonResponse(200, { success: true });
}

/**
 * PATCH /teams/:id/members/:userId — Change a user's role.
 *
 * Request body: { role: "admin" | "member" }
 *
 * Admin-only endpoint. Updates the user's role between admin and member.
 * Enforces cannot-remove-last-admin guard when demoting.
 *
 * Requirements: 10.11, 10.12, 10.13
 */
async function handleChangeRole(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = getPathParam(event, 'id') as TeamId | undefined;
  if (!teamId) {
    return jsonResponse(400, { error: 'Missing team ID' });
  }

  const targetUserId = getPathParam(event, 'userId') as UserId | undefined;
  if (!targetUserId) {
    return jsonResponse(400, { error: 'Missing user ID' });
  }

  // Enforce admin-only access
  const adminCheck = await enforceAdmin(authContext.userId, teamId);
  if (adminCheck) return adminCheck;

  // Parse request body
  let body: ChangeRoleRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  // Validate role
  const validRoles: TeamRole[] = ['admin', 'member'];
  if (!body.role || !validRoles.includes(body.role)) {
    return jsonResponse(400, {
      error: `Invalid role. Must be one of: ${validRoles.join(', ')}`,
    });
  }

  const result = await changeRole({
    userId: targetUserId,
    teamId,
    newRole: body.role,
    changedBy: authContext.userId as UserId,
  });

  if (!result.ok) {
    return mapTeamErrorToResponse(result.error);
  }

  return jsonResponse(200, result.value);
}

// =============================================================================
// Main Lambda Entry Point
// =============================================================================

/**
 * Routes incoming API Gateway events to the appropriate handler
 * based on HTTP method and path.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    // GET /teams/:id/members — List team members
    if (method === 'GET' && /^\/teams\/[^/]+\/members\/?$/.test(path)) {
      return await handleListMembers(event);
    }

    // POST /teams/:id/members — Invite user
    if (method === 'POST' && /^\/teams\/[^/]+\/members\/?$/.test(path)) {
      return await handleInviteUser(event);
    }

    // DELETE /teams/:id/members/:userId — Remove user
    if (method === 'DELETE' && /^\/teams\/[^/]+\/members\/[^/]+\/?$/.test(path)) {
      return await handleRemoveUser(event);
    }

    // PATCH /teams/:id/members/:userId — Change role
    if (method === 'PATCH' && /^\/teams\/[^/]+\/members\/[^/]+\/?$/.test(path)) {
      return await handleChangeRole(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in team handler:', error);
    return jsonResponse(500, { error: message });
  }
}
