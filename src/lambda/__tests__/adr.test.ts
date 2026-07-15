/**
 * Unit tests for the ADR Lambda handler.
 * Tests the routing, authorization, error mapping, and integration
 * with ADR generation, diagram, and cross-reference domain logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../adr';

// Mock domain modules
vi.mock('@/lib/thread-lifecycle', () => ({
  transition: vi.fn(),
}));

vi.mock('@/lib/adr-generator', () => ({
  generateADR: vi.fn(),
  exportADRToS3: vi.fn(),
  getNextSequentialId: vi.fn(),
}));

vi.mock('@/lib/diagram-generator', () => ({
  isInfrastructureDecision: vi.fn(),
  generateDecisionDiagram: vi.fn(),
  uploadDiagram: vi.fn(),
}));

vi.mock('@/lib/cross-reference', () => ({
  getReferencesForThread: vi.fn(),
  summarizeChangesSince: vi.fn(),
}));

vi.mock('@/lib/decision-journal', () => ({
  indexEntity: vi.fn(),
}));

vi.mock('@/lib/room-manager', () => ({
  getRoom: vi.fn(),
}));

vi.mock('@/services/dynamo', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
  query: vi.fn(),
}));

import { transition } from '@/lib/thread-lifecycle';
import { generateADR, exportADRToS3, getNextSequentialId } from '@/lib/adr-generator';
import { isInfrastructureDecision, generateDecisionDiagram, uploadDiagram } from '@/lib/diagram-generator';
import { getReferencesForThread } from '@/lib/cross-reference';
import { indexEntity } from '@/lib/decision-journal';
import { getRoom } from '@/lib/room-manager';
import { getItem, putItem, query } from '@/services/dynamo';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  authContext?: { userId: string; email: string; teams: string } | null;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/threads/thread-1/decide';
  const authContext = overrides.authContext !== undefined
    ? overrides.authContext
    : { userId: 'user-123', email: 'user@example.com', teams: '["team-abc"]' };

  return {
    version: '2.0',
    routeKey: `${method} ${path}`,
    rawPath: path,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789',
      apiId: 'api-id',
      authorizer: authContext ? { lambda: authContext } : undefined,
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method, path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-123',
      routeKey: `${method} ${path}`,
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    pathParameters: overrides.pathParameters,
    body: overrides.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(response: { body?: string }): unknown {
  return JSON.parse(response.body ?? '{}');
}

// =============================================================================
// Tests
// =============================================================================

describe('ADR Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /threads/:id/decide — Decide Thread', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        authContext: null,
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use DynamoDB","benefits":["Fast","Scalable"],"risks":["Cost","Complexity"],"complexity":"Medium"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        authContext: { userId: 'u1', email: 'u@e.com', teams: '[]' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use DynamoDB","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when roomId is missing', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"selectedOption":{"summary":"Use DynamoDB","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: roomId' });
    });

    it('returns 400 when selectedOption is missing', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: selectedOption' });
    });

    it('returns 404 when room not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_FOUND', roomId: 'room-x' as never },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-x","selectedOption":{"summary":"Use DynamoDB","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 404 when thread not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: null });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use DynamoDB","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 when transition is invalid', async () => {
      const mockThreadItem = {
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#DRAFT#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD',
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Test',
        status: 'DRAFT',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({
        ok: false,
        error: { kind: 'INVALID_TRANSITION', from: 'DRAFT', to: 'DECIDED', validTargets: ['IN_PROGRESS'] },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use DynamoDB","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = parseBody(response as { body: string }) as { validTargets: string[] };
      expect(body.validTargets).toEqual(['IN_PROGRESS']);
    });

    it('returns 201 with ADR on successful decide flow', async () => {
      const mockThreadItem = {
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD',
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Database Strategy',
        status: 'IN_PROGRESS',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const decidedThread = {
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Database Strategy',
        status: 'DECIDED',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        selectedOption: 'Use DynamoDB',
      };

      const mockADR = {
        adrId: 'ADR-001',
        roomId: 'room-1',
        threadId: 'thread-1',
        sequentialId: 1,
        title: 'Use DynamoDB for persistence',
        status: 'ACTIVE',
        date: '2024-01-02T00:00:00Z',
        context: 'We need a scalable database',
        optionsConsidered: [
          { name: 'DynamoDB', summary: 'NoSQL' },
          { name: 'RDS', summary: 'SQL' },
        ],
        decision: 'Use DynamoDB',
        consequences: 'Fast reads but limited queries',
        relatedDecisions: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({ ok: true, value: decidedThread as never });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(getReferencesForThread).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(getNextSequentialId).mockResolvedValue({ ok: true, value: 1 });
      vi.mocked(generateADR).mockResolvedValue({ ok: true, value: mockADR as never });
      vi.mocked(exportADRToS3).mockResolvedValue({ ok: true, value: { s3Key: 'adrs/room-1/ADR-001.json' } });
      vi.mocked(isInfrastructureDecision).mockReturnValue(false);
      vi.mocked(indexEntity).mockResolvedValue({ ok: true, value: { embedding: [] } });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use DynamoDB","benefits":["Fast","Scalable"],"risks":["Cost","Limited queries"],"complexity":"Medium"}}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(201);
      const body = parseBody(response as { body: string }) as { thread: unknown; adr: { adrId: string } };
      expect(body.adr.adrId).toBe('ADR-001');
      expect(body.thread).toEqual(decidedThread);
      expect(indexEntity).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        entityId: 'ADR-001',
        entityType: 'ADR',
      }));
    });

    it('generates diagram for infrastructure decisions', async () => {
      const mockThreadItem = {
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD',
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Kubernetes Deployment',
        status: 'IN_PROGRESS',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      const decidedThread = {
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Kubernetes Deployment',
        status: 'DECIDED',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
        selectedOption: 'Use EKS',
      };

      const mockADR = {
        adrId: 'ADR-002',
        roomId: 'room-1',
        threadId: 'thread-1',
        sequentialId: 2,
        title: 'Use EKS for container orchestration',
        status: 'ACTIVE',
        date: '2024-01-02T00:00:00Z',
        context: 'Need container orchestration',
        optionsConsidered: [
          { name: 'EKS', summary: 'Managed K8s' },
          { name: 'ECS', summary: 'AWS native' },
        ],
        decision: 'Use EKS',
        consequences: 'More flexibility but more complexity',
        relatedDecisions: [],
        createdAt: '2024-01-02T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      const mockDiagram = {
        fileName: 'kubernetes-deployment.drawio',
        content: '<mxfile></mxfile>',
        components: ['EKS', 'ALB'],
        connections: [{ from: 'ALB', to: 'EKS', label: 'traffic' }],
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({ ok: true, value: decidedThread as never });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(getReferencesForThread).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(getNextSequentialId).mockResolvedValue({ ok: true, value: 2 });
      vi.mocked(generateADR).mockResolvedValue({ ok: true, value: mockADR as never });
      vi.mocked(exportADRToS3).mockResolvedValue({ ok: true, value: { s3Key: 'adrs/room-1/ADR-002.json' } });
      vi.mocked(isInfrastructureDecision).mockReturnValue(true);
      vi.mocked(generateDecisionDiagram).mockResolvedValue({ ok: true, value: mockDiagram as never });
      vi.mocked(uploadDiagram).mockResolvedValue({ ok: true, value: { s3Key: 'diagrams/room-1/kubernetes-deployment.drawio', fileName: 'kubernetes-deployment.drawio' } });
      vi.mocked(indexEntity).mockResolvedValue({ ok: true, value: { embedding: [] } });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"Use EKS","benefits":["Flexible","Standard"],"risks":["Complex","Cost"],"complexity":"High"}}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(201);
      expect(generateDecisionDiagram).toHaveBeenCalled();
      expect(uploadDiagram).toHaveBeenCalled();
      const body = parseBody(response as { body: string }) as { adr: { diagramS3Key: string } };
      expect(body.adr.diagramS3Key).toBe('diagrams/room-1/kubernetes-deployment.drawio');
    });

    it('returns 503 when ADR generation fails', async () => {
      const mockThreadItem = {
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD',
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Test',
        status: 'IN_PROGRESS',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({ ok: true, value: { ...mockThreadItem, status: 'DECIDED' } as never });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(getReferencesForThread).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(getNextSequentialId).mockResolvedValue({ ok: true, value: 1 });
      vi.mocked(generateADR).mockResolvedValue({
        ok: false,
        error: { kind: 'TIMEOUT', elapsedMs: 30000 },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/decide',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1","selectedOption":{"summary":"X","benefits":["a","b"],"risks":["c","d"],"complexity":"Low"}}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
      const body = parseBody(response as { body: string }) as { error: string };
      expect(body.error).toContain('timed out');
    });
  });

  describe('GET /rooms/:id/adrs — List ADRs', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-1/adrs',
        authContext: null,
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 404 when room not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_FOUND', roomId: 'room-x' as never },
      });

      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-x/adrs',
        pathParameters: { id: 'room-x' },
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 200 with ADRs list on success', async () => {
      const mockADRItems = [
        {
          PK: 'ROOM#room-1',
          SK: 'ADR#ADR-001',
          entityType: 'ADR',
          adrId: 'ADR-001',
          roomId: 'room-1',
          threadId: 'thread-1',
          sequentialId: 1,
          title: 'Use DynamoDB',
          status: 'ACTIVE',
          date: '2024-01-02T00:00:00Z',
          context: 'Need persistence',
          optionsConsidered: [{ name: 'DDB', summary: 'NoSQL' }],
          decision: 'Use DynamoDB',
          consequences: 'Fast',
          relatedDecisions: [],
          createdAt: '2024-01-02T00:00:00Z',
          updatedAt: '2024-01-02T00:00:00Z',
        },
      ];

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(query).mockResolvedValue({ ok: true, value: mockADRItems });

      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-1/adrs',
        pathParameters: { id: 'room-1' },
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = parseBody(response as { body: string }) as { adrs: { adrId: string }[] };
      expect(body.adrs).toHaveLength(1);
      expect(body.adrs[0].adrId).toBe('ADR-001');
    });

    it('returns 503 when DynamoDB query fails', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(query).mockResolvedValue({
        ok: false,
        error: { kind: 'READ_FAILURE', cause: 'Network error' },
      });

      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-1/adrs',
        pathParameters: { id: 'room-1' },
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'GET', path: '/unknown' });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });
});
