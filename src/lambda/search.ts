/**
 * Lambda handler for semantic search operations.
 *
 * Endpoints:
 * - POST /rooms/:id/search — Semantic search with optional filters (2s timeout)
 *
 * The search endpoint generates a Titan embedding for the query, computes cosine
 * similarity against stored embeddings, applies structured filters, and returns
 * results ranked by similarity. Enforces a 2-second timeout.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { semanticSearch, type SearchError } from '@/lib/decision-journal';
import { getRoom } from '@/lib/room-manager';
import type { RoomId, TeamId, ThreadStatus } from '@/types/domain';

// =============================================================================
// Types
// =============================================================================

/** Context injected by the API Gateway Cognito authorizer. */
interface AuthorizerContext {
  userId: string;
  email: string;
  teams: string; // JSON-encoded string array of TeamId
}

/** Request body for POST /rooms/:id/search. */
interface SearchRequest {
  query: string;
  filters?: {
    status?: ThreadStatus;
    dateRange?: { from: string; to: string };
    title?: string;
  };
  limit?: number;
  minSimilarity?: number;
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
 * Maps a SearchError to the appropriate HTTP response.
 */
function mapSearchErrorToResponse(error: SearchError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'EMPTY_QUERY':
      return jsonResponse(400, { error: 'Search query cannot be empty' });
    case 'EMBEDDING_FAILURE':
      return jsonResponse(503, {
        error: 'Failed to generate search embedding. Please retry.',
        detail: error.cause,
      });
    case 'QUERY_FAILURE':
      return jsonResponse(503, {
        error: 'Search query failed. Please retry.',
        detail: error.cause,
      });
    case 'TIMEOUT':
      return jsonResponse(503, {
        error: 'Search timed out. Please simplify your query and retry.',
        elapsedMs: error.elapsedMs,
      });
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /rooms/:id/search — Semantic search with optional filters.
 *
 * Request body: {
 *   query: string,
 *   filters?: { status?: ThreadStatus, dateRange?: { from: string, to: string }, title?: string },
 *   limit?: number,
 *   minSimilarity?: number
 * }
 *
 * Response: 200 with SearchResult[], or error status.
 *
 * Enforces a 2-second timeout on the search operation.
 *
 * Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6
 */
async function handleSearch(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
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

  // Verify room access (team-scoped)
  const roomResult = await getRoom(roomId, teamId);
  if (!roomResult.ok) {
    if (roomResult.error.kind === 'NOT_FOUND') {
      return jsonResponse(404, { error: 'Room not found' });
    }
    return jsonResponse(503, { error: 'Service temporarily unavailable' });
  }

  // Parse request body
  let body: SearchRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.query || typeof body.query !== 'string') {
    return jsonResponse(400, { error: 'Missing required field: query' });
  }

  // Validate optional filters
  const validStatuses: ThreadStatus[] = ['DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];
  if (body.filters?.status && !validStatuses.includes(body.filters.status)) {
    return jsonResponse(400, {
      error: `Invalid filter status. Must be one of: ${validStatuses.join(', ')}`,
    });
  }

  // Build search filters, converting date strings to Date objects
  const filters = body.filters
    ? {
        status: body.filters.status,
        dateRange: body.filters.dateRange
          ? {
              from: new Date(body.filters.dateRange.from),
              to: new Date(body.filters.dateRange.to),
            }
          : undefined,
        title: body.filters.title,
      }
    : undefined;

  // Validate date range if provided
  if (filters?.dateRange) {
    if (isNaN(filters.dateRange.from.getTime()) || isNaN(filters.dateRange.to.getTime())) {
      return jsonResponse(400, { error: 'Invalid date range format. Use ISO 8601 dates.' });
    }
    if (filters.dateRange.from > filters.dateRange.to) {
      return jsonResponse(400, { error: 'dateRange.from must be before dateRange.to' });
    }
  }

  // Execute semantic search (2s timeout enforced internally)
  const searchResult = await semanticSearch({
    roomId,
    query: body.query,
    filters,
    limit: body.limit,
    minSimilarity: body.minSimilarity,
  });

  if (!searchResult.ok) {
    return mapSearchErrorToResponse(searchResult.error);
  }

  return jsonResponse(200, { results: searchResult.value });
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
    // POST /rooms/:id/search — Semantic search
    if (method === 'POST' && /^\/rooms\/[^/]+\/search\/?$/.test(path)) {
      return await handleSearch(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in search handler:', error);
    return jsonResponse(500, { error: message });
  }
}
