/**
 * Lambda handlers for Room operations.
 *
 * Endpoints:
 * - POST /rooms — Create a new room (team-scoped)
 * - GET /rooms — List rooms for the authenticated user's team
 * - GET /rooms/:id — Get a room with its threads
 *
 * All mutations use write-before-acknowledge: DynamoDB persistence completes
 * before returning success to the client.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createRoom, getRoom, listRoomsForTeam } from '@/lib/room-manager';
import { query } from '@/services/dynamo';
import type { RoomId, TeamId, ThreadItem, DecisionThread } from '@/types/domain';
import type { RoomError } from '@/lib/room-manager';

// =============================================================================
// Types
// =============================================================================

/** Context injected by the API Gateway Cognito authorizer. */
interface AuthorizerContext {
  userId: string;
  email: string;
  teams: string; // JSON-encoded string array of TeamId
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the authorizer context from the API Gateway event.
 * First checks for API Gateway authorizer context, then falls back
 * to decoding the Authorization Bearer token directly.
 */
function extractAuthContext(event: APIGatewayProxyEventV2): AuthorizerContext | null {
  // Try API Gateway authorizer context first
  const context = (event.requestContext as unknown as { authorizer?: { lambda?: AuthorizerContext; jwt?: { claims: Record<string, string> } } })
    ?.authorizer;

  if (context?.lambda?.userId && context?.lambda?.teams) {
    return context.lambda;
  }

  // Fall back to decoding the Bearer token from the Authorization header
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  try {
    const tokenParts = parts[1].split('.');
    if (tokenParts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());

    const userId = payload.sub ?? payload['cognito:username'] ?? '';
    const email = payload.email ?? '';
    const groups = payload['cognito:groups'] ?? [];

    if (!userId) return null;

    return {
      userId,
      email,
      teams: JSON.stringify(groups),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts the user's primary team (first team in the array).
 * Returns null if the user has no team assignments.
 */
function extractTeamId(authContext: AuthorizerContext): TeamId | null {
  try {
    const teams: string[] = JSON.parse(authContext.teams);
    if (teams.length === 0) return null;
    return teams[0] as TeamId;
  } catch {
    return null;
  }
}

/**
 * Maps a RoomError to the appropriate HTTP status code and response body.
 */
function mapRoomErrorToResponse(error: RoomError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'EMPTY_NAME':
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Room name cannot be empty' }),
      };
    case 'NAME_TOO_LONG':
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: `Room name cannot exceed ${error.maxLength} characters`,
        }),
      };
    case 'DUPLICATE_NAME':
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'A room with this name already exists',
          existingId: error.existingId,
        }),
      };
    case 'NOT_FOUND':
      return {
        statusCode: 404,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Room not found' }),
      };
    case 'PERSISTENCE_FAILURE':
      return {
        statusCode: 503,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          error: 'Service temporarily unavailable. Please retry.',
          detail: error.cause,
        }),
      };
  }
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
 * Extracts a path parameter from the event (e.g., /rooms/:id).
 */
function getPathParam(event: APIGatewayProxyEventV2, paramName: string): string | undefined {
  return event.pathParameters?.[paramName];
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /rooms — Create a new room.
 *
 * Request body: { name: string }
 * Response: 201 with created Room, or error status.
 *
 * Write-before-acknowledge: Room is persisted to DynamoDB before returning success.
 */
async function handleCreateRoom(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  // Parse request body
  let body: { name?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.name || typeof body.name !== 'string') {
    return jsonResponse(400, { error: 'Missing required field: name' });
  }

  // Create room (persists to DynamoDB before returning)
  const result = await createRoom({
    name: body.name,
    teamId,
    createdBy: authContext.userId,
  });

  if (!result.ok) {
    return mapRoomErrorToResponse(result.error);
  }

  return jsonResponse(201, result.value);
}

/**
 * GET /rooms — List all rooms for the authenticated user's team.
 *
 * Response: 200 with Room[]
 */
async function handleListRooms(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const result = await listRoomsForTeam(teamId);

  if (!result.ok) {
    return mapRoomErrorToResponse(result.error);
  }

  return jsonResponse(200, { rooms: result.value });
}

/**
 * GET /rooms/:id — Get a room with its threads.
 *
 * Response: 200 with Room and DecisionThread[], or 404 if not found.
 */
async function handleGetRoom(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const roomId = getPathParam(event, 'roomId') as RoomId | undefined;
  if (!roomId) {
    return jsonResponse(400, { error: 'Missing room ID' });
  }

  // Get the room (team-scoped)
  const roomResult = await getRoom(roomId, teamId);
  if (!roomResult.ok) {
    return mapRoomErrorToResponse(roomResult.error);
  }

  // Fetch threads for this room
  const threadsResult = await query<ThreadItem>({
    pk: `ROOM#${roomId}`,
    skPrefix: 'THREAD#',
  });

  const threads: DecisionThread[] = threadsResult.ok
    ? threadsResult.value.map((item) => ({
        threadId: item.threadId as unknown as DecisionThread['threadId'],
        roomId: item.roomId as unknown as DecisionThread['roomId'],
        title: item.title,
        status: item.status,
        createdBy: item.createdBy,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        selectedOption: item.selectedOption,
        reopenMarkers: item.reopenMarkers,
        supersededBy: item.supersededBy as DecisionThread['supersededBy'],
      }))
    : [];

  return jsonResponse(200, {
    room: roomResult.value,
    threads,
  });
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
    // POST /rooms — Create room
    if (method === 'POST' && /^\/rooms\/?$/.test(path)) {
      return await handleCreateRoom(event);
    }

    // GET /rooms — List rooms
    if (method === 'GET' && /^\/rooms\/?$/.test(path)) {
      return await handleListRooms(event);
    }

    // GET /rooms/:id — Get room with threads
    if (method === 'GET' && /^\/rooms\/[^/]+\/?$/.test(path)) {
      return await handleGetRoom(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in room handler:', error);
    return jsonResponse(500, { error: message });
  }
}
