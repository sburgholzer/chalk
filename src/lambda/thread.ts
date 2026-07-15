/**
 * Lambda handlers for Decision Thread operations.
 *
 * Endpoints:
 * - POST /rooms/:id/threads — Create a new thread in a room
 * - POST /threads/:id/transition — Transition thread status
 *
 * All mutations use write-before-acknowledge: DynamoDB persistence completes
 * before returning success to the client.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { createThread, transition, type ThreadError } from '@/lib/thread-lifecycle';
import { getRoom } from '@/lib/room-manager';
import { getItem, putItem } from '@/services/dynamo';
import type {
  RoomId,
  TeamId,
  ThreadId,
  ThreadStatus,
  ThreadItem,
  DecisionThread,
  Option,
} from '@/types/domain';

// =============================================================================
// Types
// =============================================================================

/** Context injected by the API Gateway Cognito authorizer. */
interface AuthorizerContext {
  userId: string;
  email: string;
  teams: string; // JSON-encoded string array of TeamId
}

/** Request body for POST /threads/:id/transition. */
interface TransitionRequest {
  targetStatus: ThreadStatus;
  selectedOption?: Option;
  reopenReason?: string;
  supersededBy?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the authorizer context from the API Gateway event.
 */
function extractAuthContext(event: APIGatewayProxyEventV2): AuthorizerContext | null {
  const context = (event.requestContext as unknown as { authorizer?: { lambda?: AuthorizerContext } })
    ?.authorizer;

  if (context?.lambda?.userId && context?.lambda?.teams) {
    return context.lambda;
  }

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
 * Maps a ThreadError to the appropriate HTTP status code and response body.
 */
function mapThreadErrorToResponse(error: ThreadError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'INVALID_TRANSITION':
      return jsonResponse(400, {
        error: `Invalid transition from ${error.from} to ${error.to}`,
        validTargets: error.validTargets,
      });
    case 'NOT_FOUND':
      return jsonResponse(404, {
        error: 'Thread not found',
        threadId: error.threadId,
      });
    case 'PERSISTENCE_FAILURE':
      return jsonResponse(503, {
        error: 'Service temporarily unavailable. Please retry.',
        detail: error.cause,
      });
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
 * Extracts a path parameter from the event.
 */
function getPathParam(event: APIGatewayProxyEventV2, paramName: string): string | undefined {
  return event.pathParameters?.[paramName];
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /rooms/:id/threads — Create a new thread in a room.
 *
 * Request body: { title: string }
 * Response: 201 with created DecisionThread, or error status.
 *
 * Write-before-acknowledge: Thread is persisted to DynamoDB before returning success.
 * Validates that the room exists and belongs to the user's team.
 */
async function handleCreateThread(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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

  // Verify room exists and belongs to the user's team
  const roomResult = await getRoom(roomId, teamId);
  if (!roomResult.ok) {
    if (roomResult.error.kind === 'NOT_FOUND') {
      return jsonResponse(404, { error: 'Room not found' });
    }
    return jsonResponse(503, { error: 'Service temporarily unavailable' });
  }

  // Parse request body
  let body: { title?: string };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.title || typeof body.title !== 'string' || body.title.trim().length === 0) {
    return jsonResponse(400, { error: 'Missing or empty required field: title' });
  }

  // Create thread (persists to DynamoDB before returning)
  const result = await createThread({
    roomId,
    title: body.title.trim(),
    createdBy: authContext.userId,
  });

  if (!result.ok) {
    return mapThreadErrorToResponse(result.error);
  }

  return jsonResponse(201, result.value);
}

/**
 * POST /threads/:id/transition — Transition a thread's status.
 *
 * Request body: {
 *   targetStatus: ThreadStatus,
 *   selectedOption?: Option,      // Required for IN_PROGRESS → DECIDED
 *   reopenReason?: string,        // Optional for DECIDED → IN_PROGRESS
 *   supersededBy?: string         // Required for DECIDED → SUPERSEDED
 * }
 *
 * Response: 200 with updated DecisionThread, or error status.
 *
 * Write-before-acknowledge: Updated thread state is persisted to DynamoDB
 * before returning success to the client.
 */
async function handleTransition(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const threadId = getPathParam(event, 'threadId') as ThreadId | undefined;
  if (!threadId) {
    return jsonResponse(400, { error: 'Missing thread ID' });
  }

  // Parse request body
  let body: TransitionRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.targetStatus) {
    return jsonResponse(400, { error: 'Missing required field: targetStatus' });
  }

  const validStatuses: ThreadStatus[] = ['DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];
  if (!validStatuses.includes(body.targetStatus)) {
    return jsonResponse(400, {
      error: `Invalid targetStatus. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  // Fetch the current thread from DynamoDB
  // We need to find the thread by ID. Since the thread PK is ROOM#{roomId},
  // we need to determine the room. We'll look up the thread from all rooms
  // the user's team has access to. For efficiency, we'll use the GSI1 or
  // iterate over the user's rooms. However, the simpler approach is to require
  // the roomId in the request or get it from context.
  //
  // For this implementation, we require roomId in the body for thread lookup.
  // Alternatively, we can scan. Let's require it in the body.
  const roomId = (body as unknown as { roomId?: string }).roomId as RoomId | undefined;

  if (!roomId) {
    return jsonResponse(400, { error: 'Missing required field: roomId' });
  }

  // Verify room access (team-scoped)
  const roomResult = await getRoom(roomId, teamId);
  if (!roomResult.ok) {
    if (roomResult.error.kind === 'NOT_FOUND') {
      return jsonResponse(404, { error: 'Room not found' });
    }
    return jsonResponse(503, { error: 'Service temporarily unavailable' });
  }

  // Fetch the thread item from DynamoDB
  const threadResult = await getItem<ThreadItem>({
    pk: `ROOM#${roomId}`,
    sk: `THREAD#${threadId}`,
  });

  if (!threadResult.ok) {
    return jsonResponse(503, {
      error: 'Service temporarily unavailable',
      detail: threadResult.error.kind === 'READ_FAILURE' ? threadResult.error.cause : 'Unknown error',
    });
  }

  if (!threadResult.value) {
    return jsonResponse(404, { error: 'Thread not found' });
  }

  const threadItem = threadResult.value;

  // Reconstruct the DecisionThread from the DynamoDB item
  const currentThread: DecisionThread = {
    threadId: threadItem.threadId as ThreadId,
    roomId: threadItem.roomId as RoomId,
    title: threadItem.title,
    status: threadItem.status,
    createdBy: threadItem.createdBy,
    createdAt: threadItem.createdAt,
    updatedAt: threadItem.updatedAt,
    selectedOption: threadItem.selectedOption,
    reopenMarkers: threadItem.reopenMarkers,
    supersededBy: threadItem.supersededBy as ThreadId | undefined,
  };

  // Perform the transition (validates state machine rules)
  const transitionResult = transition(currentThread, body.targetStatus, {
    selectedOption: body.selectedOption,
    supersededBy: body.supersededBy as ThreadId | undefined,
    reopenReason: body.reopenReason,
  });

  if (!transitionResult.ok) {
    return mapThreadErrorToResponse(transitionResult.error);
  }

  const updatedThread = transitionResult.value;

  // Persist the updated thread to DynamoDB (write-before-acknowledge)
  const updatedItem: ThreadItem = {
    PK: `ROOM#${roomId}`,
    SK: `THREAD#${threadId}`,
    GSI1PK: `ROOM#${roomId}`,
    GSI1SK: `STATUS#${updatedThread.status}#DATE#${updatedThread.updatedAt}`,
    entityType: 'THREAD',
    threadId: updatedThread.threadId,
    roomId: updatedThread.roomId,
    title: updatedThread.title,
    status: updatedThread.status,
    createdBy: updatedThread.createdBy,
    createdAt: updatedThread.createdAt,
    updatedAt: updatedThread.updatedAt,
    selectedOption: updatedThread.selectedOption,
    reopenMarkers: updatedThread.reopenMarkers,
    supersededBy: updatedThread.supersededBy,
  };

  const writeResult = await putItem({ item: updatedItem as unknown as Record<string, unknown> });

  if (!writeResult.ok) {
    return jsonResponse(503, {
      error: 'Failed to persist thread transition. Please retry.',
      detail: writeResult.error.kind === 'WRITE_FAILURE' ? writeResult.error.cause : 'Unknown write error',
    });
  }

  return jsonResponse(200, updatedThread);
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
    // POST /rooms/:id/threads — Create thread in room
    if (method === 'POST' && /^\/rooms\/[^/]+\/threads\/?$/.test(path)) {
      return await handleCreateThread(event);
    }

    // POST /threads/:id/transition — Transition thread status
    if (method === 'POST' && /^\/threads\/[^/]+\/transition\/?$/.test(path)) {
      return await handleTransition(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in thread handler:', error);
    return jsonResponse(500, { error: message });
  }
}
