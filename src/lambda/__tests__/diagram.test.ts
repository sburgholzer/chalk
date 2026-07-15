/**
 * Unit tests for the Diagram Lambda handler.
 * Tests the routing, authorization, error mapping, and integration
 * with the diagram generator domain logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../diagram';

// Mock domain modules
vi.mock('@/lib/diagram-generator', () => ({
  generateOptionComparisonDiagram: vi.fn(),
  uploadDiagram: vi.fn(),
}));

vi.mock('@/lib/room-manager', () => ({
  getRoom: vi.fn(),
}));

vi.mock('@/services/dynamo', () => ({
  getItem: vi.fn(),
}));

import { generateOptionComparisonDiagram, uploadDiagram } from '@/lib/diagram-generator';
import { getRoom } from '@/lib/room-manager';
import { getItem } from '@/services/dynamo';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  authContext?: { userId: string; email: string; teams: string } | null;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/threads/thread-1/diagram';
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

describe('Diagram Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /threads/:id/diagram — Generate Comparison Diagram', () => {
    const validOptions = [
      { summary: 'Use EKS', benefits: ['Flexible', 'Standard'], risks: ['Complex', 'Costly'], complexity: 'High' as const },
      { summary: 'Use ECS', benefits: ['Simple', 'Integrated'], risks: ['Lock-in', 'Less flexible'], complexity: 'Medium' as const },
    ];

    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        authContext: null,
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        authContext: { userId: 'u1', email: 'u@e.com', teams: '[]' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when roomId is missing', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ options: validOptions }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: roomId' });
    });

    it('returns 400 when options are missing', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1' }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when fewer than 2 options provided', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: [validOptions[0]] }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when more than 5 options provided', async () => {
      const sixOptions = Array.from({ length: 6 }, (_, i) => ({
        summary: `Option ${i + 1}`,
        benefits: ['a', 'b'],
        risks: ['c', 'd'],
        complexity: 'Low' as const,
      }));
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: sixOptions }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
    });

    it('returns 404 when room not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_FOUND', roomId: 'room-x' as never },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-x', options: validOptions }),
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
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 201 with diagram metadata on success', async () => {
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

      const mockDiagram = {
        fileName: 'kubernetes-deployment-comparison.drawio',
        content: '<mxfile></mxfile>',
        components: ['EKS', 'ECS', 'ALB'],
        connections: [
          { from: 'ALB', to: 'EKS', label: 'traffic' },
          { from: 'ALB', to: 'ECS', label: 'traffic' },
        ],
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(generateOptionComparisonDiagram).mockResolvedValue({ ok: true, value: mockDiagram as never });
      vi.mocked(uploadDiagram).mockResolvedValue({
        ok: true,
        value: { s3Key: 'diagrams/room-1/kubernetes-deployment-comparison.drawio', fileName: 'kubernetes-deployment-comparison.drawio' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(201);
      const body = parseBody(response as { body: string }) as {
        s3Key: string;
        fileName: string;
        components: string[];
        connections: { from: string; to: string }[];
      };
      expect(body.s3Key).toBe('diagrams/room-1/kubernetes-deployment-comparison.drawio');
      expect(body.fileName).toBe('kubernetes-deployment-comparison.drawio');
      expect(body.components).toEqual(['EKS', 'ECS', 'ALB']);
      expect(body.connections).toHaveLength(2);
    });

    it('returns 400 when thread is not infrastructure-related', async () => {
      const mockThreadItem = {
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD',
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Code Review Process',
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
      vi.mocked(generateOptionComparisonDiagram).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_INFRASTRUCTURE', reason: 'Thread does not involve infrastructure' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
    });

    it('returns 503 when diagram generation fails', async () => {
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

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(generateOptionComparisonDiagram).mockResolvedValue({
        ok: false,
        error: { kind: 'GENERATION_FAILURE', cause: 'Bedrock timeout' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
    });

    it('returns 503 when S3 upload fails', async () => {
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

      const mockDiagram = {
        fileName: 'kubernetes-deployment-comparison.drawio',
        content: '<mxfile></mxfile>',
        components: ['EKS'],
        connections: [],
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(generateOptionComparisonDiagram).mockResolvedValue({ ok: true, value: mockDiagram as never });
      vi.mocked(uploadDiagram).mockResolvedValue({
        ok: false,
        error: { kind: 'S3_UPLOAD_FAILURE', cause: 'Network error' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/diagram',
        pathParameters: { id: 'thread-1' },
        body: JSON.stringify({ roomId: 'room-1', options: validOptions }),
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'GET', path: '/threads/thread-1/diagram' });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });
});
