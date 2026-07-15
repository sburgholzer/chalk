/**
 * Lambda handler for diagram generation operations.
 *
 * Endpoints:
 * - POST /threads/:id/diagram — Generate an option comparison diagram during
 *   deliberation, upload to S3
 *
 * Diagrams are generated using Amazon Bedrock Claude and uploaded to S3 as
 * .drawio XML files.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import {
  generateOptionComparisonDiagram,
  uploadDiagram,
  type DiagramError,
} from '@/lib/diagram-generator';
import { getRoom } from '@/lib/room-manager';
import { getItem } from '@/services/dynamo';
import type {
  RoomId,
  TeamId,
  ThreadId,
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

/** Request body for POST /threads/:id/diagram. */
interface DiagramRequest {
  roomId: string;
  options: Option[];
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
 * Maps a DiagramError to the appropriate HTTP response.
 */
function mapDiagramErrorToResponse(error: DiagramError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'NOT_INFRASTRUCTURE':
      return jsonResponse(400, {
        error: 'Thread does not involve infrastructure-related architecture',
        detail: error.reason,
      });
    case 'GENERATION_FAILURE':
      return jsonResponse(503, {
        error: 'Diagram generation failed. Please retry.',
        detail: error.cause,
      });
    case 'S3_UPLOAD_FAILURE':
      return jsonResponse(503, {
        error: 'Failed to upload diagram to S3. Please retry.',
        detail: error.cause,
      });
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /threads/:id/diagram — Generate an option comparison diagram.
 *
 * Used during deliberation (IN_PROGRESS status) to visually compare architecture
 * options side by side in a .drawio format.
 *
 * Request body: {
 *   roomId: string,
 *   options: Option[] (2-5 options to compare)
 * }
 *
 * Flow:
 * 1. Validate auth and fetch thread
 * 2. Generate option comparison diagram via Bedrock Claude
 * 3. Upload diagram to S3
 * 4. Return diagram metadata (S3 key, file name, components, connections)
 *
 * Requirements: 8.3
 */
async function handleGenerateDiagram(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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
  let body: DiagramRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.roomId) {
    return jsonResponse(400, { error: 'Missing required field: roomId' });
  }

  if (!body.options || !Array.isArray(body.options) || body.options.length < 2) {
    return jsonResponse(400, {
      error: 'Missing or invalid required field: options (must be an array with at least 2 options)',
    });
  }

  if (body.options.length > 5) {
    return jsonResponse(400, {
      error: 'Too many options. Maximum is 5 options for comparison.',
    });
  }

  const roomId = body.roomId as RoomId;

  // Verify room access (team-scoped)
  const roomResult = await getRoom(roomId, teamId);
  if (!roomResult.ok) {
    if (roomResult.error.kind === 'NOT_FOUND') {
      return jsonResponse(404, { error: 'Room not found' });
    }
    return jsonResponse(503, { error: 'Service temporarily unavailable' });
  }

  // Fetch the current thread from DynamoDB
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

  // Reconstruct DecisionThread from DynamoDB item
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

  // Generate option comparison diagram
  const diagramResult = await generateOptionComparisonDiagram({
    thread: currentThread,
    options: body.options,
  });

  if (!diagramResult.ok) {
    return mapDiagramErrorToResponse(diagramResult.error);
  }

  const diagram = diagramResult.value;

  // Upload diagram to S3
  const uploadResult = await uploadDiagram(diagram, roomId);

  if (!uploadResult.ok) {
    return mapDiagramErrorToResponse(uploadResult.error);
  }

  return jsonResponse(201, {
    s3Key: uploadResult.value.s3Key,
    fileName: uploadResult.value.fileName,
    components: diagram.components,
    connections: diagram.connections,
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
    // POST /threads/:id/diagram — Generate comparison diagram
    if (method === 'POST' && /^\/threads\/[^/]+\/diagram\/?$/.test(path)) {
      return await handleGenerateDiagram(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in diagram handler:', error);
    return jsonResponse(500, { error: message });
  }
}
