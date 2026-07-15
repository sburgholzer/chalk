/**
 * Lambda handlers for ADR (Architecture Decision Record) operations.
 *
 * Endpoints:
 * - POST /threads/:id/decide — Transition to DECIDED, generate ADR + S3 export,
 *   optionally generate diagram if infrastructure decision, index ADR embedding
 * - GET /rooms/:id/adrs — List all ADRs in a room
 *
 * All mutations use write-before-acknowledge: DynamoDB persistence completes
 * before returning success to the client.
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { transition, type ThreadError } from '@/lib/thread-lifecycle';
import { generateADR, exportADRToS3, getNextSequentialId, type ADRError } from '@/lib/adr-generator';
import {
  isInfrastructureDecision,
  generateDecisionDiagram,
  uploadDiagram,
} from '@/lib/diagram-generator';
import { getReferencesForThread, summarizeChangesSince } from '@/lib/cross-reference';
import { indexEntity } from '@/lib/decision-journal';
import { getRoom } from '@/lib/room-manager';
import { getItem, putItem, query } from '@/services/dynamo';
import type {
  RoomId,
  TeamId,
  ThreadId,
  ThreadItem,
  ADRItem,
  ADR,
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

/** Request body for POST /threads/:id/decide. */
interface DecideRequest {
  roomId: string;
  selectedOption: Option;
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
 * Maps a ThreadError to the appropriate HTTP response.
 */
function mapThreadErrorToResponse(error: ThreadError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'INVALID_TRANSITION':
      return jsonResponse(400, {
        error: `Invalid transition from ${error.from} to ${error.to}`,
        validTargets: error.validTargets,
      });
    case 'NOT_FOUND':
      return jsonResponse(404, { error: 'Thread not found', threadId: error.threadId });
    case 'PERSISTENCE_FAILURE':
      return jsonResponse(503, {
        error: 'Service temporarily unavailable. Please retry.',
        detail: error.cause,
      });
  }
}

/**
 * Maps an ADRError to the appropriate HTTP response.
 */
function mapADRErrorToResponse(error: ADRError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'INSUFFICIENT_CONTEXT':
      return jsonResponse(400, {
        error: 'Insufficient context for ADR generation',
        missingSections: error.missingSections,
      });
    case 'GENERATION_FAILURE':
      return jsonResponse(503, {
        error: 'ADR generation failed. Please retry.',
        detail: error.cause,
        attempt: error.attempt,
      });
    case 'S3_UPLOAD_FAILURE':
      return jsonResponse(503, {
        error: 'Failed to export ADR to S3. Please retry.',
        detail: error.cause,
      });
    case 'TIMEOUT':
      return jsonResponse(503, {
        error: 'ADR generation timed out. Please retry.',
        elapsedMs: error.elapsedMs,
      });
  }
}

// =============================================================================
// Handlers
// =============================================================================

/**
 * POST /threads/:id/decide — Transition thread to DECIDED, generate ADR.
 *
 * Flow:
 * 1. Validate auth and fetch thread
 * 2. Transition thread to DECIDED via state machine
 * 3. Get cross-references for the thread
 * 4. Generate ADR (with 30s timeout, up to 3 retries)
 * 5. Persist ADR to DynamoDB
 * 6. Export ADR to S3
 * 7. If infrastructure decision: generate diagram + upload to S3
 * 8. Index ADR entity for semantic search
 * 9. Return ADR to client
 *
 * If a DECIDED thread is being reopened (decided → in_progress), wire
 * summarizeChangesSince to report what changed since the decision.
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 8.1, 8.2
 */
async function handleDecide(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const threadId = getPathParam(event, 'id') as ThreadId | undefined;
  if (!threadId) {
    return jsonResponse(400, { error: 'Missing thread ID' });
  }

  // Parse request body
  let body: DecideRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.roomId) {
    return jsonResponse(400, { error: 'Missing required field: roomId' });
  }

  if (!body.selectedOption || !body.selectedOption.summary) {
    return jsonResponse(400, { error: 'Missing required field: selectedOption' });
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

  // Step 1: Transition thread to DECIDED
  const transitionResult = transition(currentThread, 'DECIDED', {
    selectedOption: body.selectedOption,
  });

  if (!transitionResult.ok) {
    return mapThreadErrorToResponse(transitionResult.error);
  }

  const decidedThread = transitionResult.value;

  // Persist updated thread (write-before-acknowledge)
  const updatedThreadItem: ThreadItem = {
    PK: `ROOM#${roomId}`,
    SK: `THREAD#${threadId}`,
    GSI1PK: `ROOM#${roomId}`,
    GSI1SK: `STATUS#${decidedThread.status}#DATE#${decidedThread.updatedAt}`,
    entityType: 'THREAD',
    threadId: decidedThread.threadId,
    roomId: decidedThread.roomId,
    title: decidedThread.title,
    status: decidedThread.status,
    createdBy: decidedThread.createdBy,
    createdAt: decidedThread.createdAt,
    updatedAt: decidedThread.updatedAt,
    selectedOption: decidedThread.selectedOption,
    reopenMarkers: decidedThread.reopenMarkers,
    supersededBy: decidedThread.supersededBy,
  };

  const threadWriteResult = await putItem({ item: updatedThreadItem as unknown as Record<string, unknown> });
  if (!threadWriteResult.ok) {
    return jsonResponse(503, {
      error: 'Failed to persist thread transition. Please retry.',
    });
  }

  // Step 2: Get cross-references for the thread
  const crossRefsResult = await getReferencesForThread(threadId);
  const crossReferences = crossRefsResult.ok ? crossRefsResult.value : [];

  // Step 3: Get next sequential ADR ID
  const seqIdResult = await getNextSequentialId(roomId);
  if (!seqIdResult.ok) {
    return mapADRErrorToResponse(seqIdResult.error);
  }

  // Step 4: Generate ADR (30s timeout, up to 3 retries)
  const adrResult = await generateADR({
    thread: decidedThread,
    selectedOption: body.selectedOption.summary,
    crossReferences,
    nextSequentialId: seqIdResult.value,
  });

  if (!adrResult.ok) {
    return mapADRErrorToResponse(adrResult.error);
  }

  const adr = adrResult.value;

  // Step 5: Persist ADR to DynamoDB
  const adrItem: ADRItem & Record<string, unknown> = {
    PK: `ROOM#${roomId}`,
    SK: `ADR#${adr.adrId}`,
    GSI3PK: `ROOM#${roomId}`,
    GSI3SK: `ADR_SEQ#${String(adr.sequentialId).padStart(3, '0')}`,
    entityType: 'ADR',
    adrId: adr.adrId,
    roomId: adr.roomId,
    threadId: adr.threadId,
    sequentialId: adr.sequentialId,
    title: adr.title,
    status: adr.status,
    date: adr.date,
    context: adr.context,
    optionsConsidered: adr.optionsConsidered,
    decision: adr.decision,
    consequences: adr.consequences,
    relatedDecisions: adr.relatedDecisions,
    createdAt: adr.createdAt,
    updatedAt: adr.updatedAt,
  };

  const adrWriteResult = await putItem({ item: adrItem });
  if (!adrWriteResult.ok) {
    return jsonResponse(503, { error: 'Failed to persist ADR. Please retry.' });
  }

  // Step 6: Export ADR to S3
  const exportResult = await exportADRToS3(adr);
  let s3ExportKey: string | undefined;
  if (exportResult.ok) {
    s3ExportKey = exportResult.value.s3Key;
    // Update ADR item with s3ExportKey
    await putItem({ item: { ...adrItem, s3ExportKey } });
  }
  // S3 export failure is non-blocking — ADR is already persisted

  // Step 7: If infrastructure decision, generate diagram and upload to S3
  let diagramS3Key: string | undefined;
  if (isInfrastructureDecision(decidedThread)) {
    const diagramResult = await generateDecisionDiagram({
      thread: decidedThread,
      selectedOption: body.selectedOption,
    });

    if (diagramResult.ok) {
      const uploadResult = await uploadDiagram(diagramResult.value, roomId);
      if (uploadResult.ok) {
        diagramS3Key = uploadResult.value.s3Key;
        // Update ADR item with diagramS3Key
        await putItem({ item: { ...adrItem, s3ExportKey, diagramS3Key } });
      }
    }
    // Diagram generation failure does not block the response (Requirement 8.4)
  }

  // Step 8: Index ADR entity for semantic search
  await indexEntity({
    roomId,
    entityId: adr.adrId,
    entityType: 'ADR',
    content: `${adr.title} ${adr.context} ${adr.decision} ${adr.consequences}`,
    summary: adr.title.slice(0, 200),
  });

  // Return the complete ADR response
  return jsonResponse(201, {
    thread: decidedThread,
    adr: {
      ...adr,
      s3ExportKey,
      diagramS3Key,
    },
  });
}

/**
 * GET /rooms/:id/adrs — List all ADRs in a room.
 *
 * Queries DynamoDB with PK=ROOM#{roomId}, SK begins_with ADR#.
 *
 * Response: 200 with ADR[]
 */
async function handleListADRs(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const roomId = getPathParam(event, 'id') as RoomId | undefined;
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

  // Query ADRs in the room
  const adrsResult = await query<ADRItem>({
    pk: `ROOM#${roomId}`,
    skPrefix: 'ADR#',
  });

  if (!adrsResult.ok) {
    return jsonResponse(503, {
      error: 'Failed to query ADRs. Please retry.',
      detail: adrsResult.error.kind === 'READ_FAILURE' ? adrsResult.error.cause : 'Unknown error',
    });
  }

  // Map DynamoDB items to ADR response objects
  const adrs: ADR[] = adrsResult.value.map((item) => ({
    adrId: item.adrId,
    roomId: item.roomId as RoomId,
    threadId: item.threadId as ThreadId,
    sequentialId: item.sequentialId,
    title: item.title,
    status: item.status,
    date: item.date,
    context: item.context,
    optionsConsidered: item.optionsConsidered,
    decision: item.decision,
    consequences: item.consequences,
    relatedDecisions: item.relatedDecisions,
    diagramS3Key: item.diagramS3Key,
    s3ExportKey: item.s3ExportKey,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));

  return jsonResponse(200, { adrs });
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
    // POST /threads/:id/decide — Transition to DECIDED and generate ADR
    if (method === 'POST' && /^\/threads\/[^/]+\/decide\/?$/.test(path)) {
      return await handleDecide(event);
    }

    // GET /rooms/:id/adrs — List ADRs in room
    if (method === 'GET' && /^\/rooms\/[^/]+\/adrs\/?$/.test(path)) {
      return await handleListADRs(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in ADR handler:', error);
    return jsonResponse(500, { error: message });
  }
}
