/**
 * Unit tests for the Thread Lambda handler.
 * Tests the routing, authorization, error mapping, and integration
 * with the thread-lifecycle domain logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../thread';

// Mock the thread-lifecycle module
vi.mock('@/lib/thread-lifecycle', () => ({
  createThread: vi.fn(),
  transition: vi.fn(),
}));

// Mock the room-manager module (for room access verification)
vi.mock('@/lib/room-manager', () => ({
  getRoom: vi.fn(),
}));

// Mock the dynamo service
vi.mock('@/services/dynamo', () => ({
  getItem: vi.fn(),
  putItem: vi.fn(),
}));

import { createThread, transition } from '@/lib/thread-lifecycle';
import { getRoom } from '@/lib/room-manager';
import { getItem, putItem } from '@/services/dynamo';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  authContext?: { userId: string; email: string; teams: string } | null;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/rooms/room-1/threads';
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

describe('Thread Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /rooms/:id/threads — Create Thread', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/threads',
        authContext: null,
        body: '{"title":"Test Thread"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/threads',
        authContext: { userId: 'u1', email: 'u@e.com', teams: '[]' },
        body: '{"title":"Test"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
    });

    it('returns 404 when room does not exist', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_FOUND', roomId: 'room-x' as never },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-x/threads',
        pathParameters: { id: 'room-x' },
        body: '{"title":"Test Thread"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 when title is missing', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/threads',
        pathParameters: { id: 'room-1' },
        body: '{}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing or empty required field: title' });
    });

    it('returns 201 with thread on successful creation', async () => {
      const mockThread = {
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Database Strategy',
        status: 'DRAFT',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      };
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(createThread).mockResolvedValue({ ok: true, value: mockThread as never });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/threads',
        pathParameters: { id: 'room-1' },
        body: '{"title":"Database Strategy"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(201);
      expect(parseBody(response as { body: string })).toEqual(mockThread);
      expect(createThread).toHaveBeenCalledWith({
        roomId: 'room-1',
        title: 'Database Strategy',
        createdBy: 'user-123',
      });
    });

    it('maps PERSISTENCE_FAILURE to 503', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(createThread).mockResolvedValue({
        ok: false,
        error: { kind: 'PERSISTENCE_FAILURE', cause: 'DDB timeout' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/threads',
        pathParameters: { id: 'room-1' },
        body: '{"title":"Test"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(503);
    });
  });

  describe('POST /threads/:id/transition — Transition Thread Status', () => {
    const mockThreadItem = {
      PK: 'ROOM#room-1',
      SK: 'THREAD#thread-1',
      GSI1PK: 'ROOM#room-1',
      GSI1SK: 'STATUS#DRAFT#DATE#2024-01-01T00:00:00Z',
      entityType: 'THREAD' as const,
      threadId: 'thread-1',
      roomId: 'room-1',
      title: 'Test Thread',
      status: 'DRAFT' as const,
      createdBy: 'user-123',
      createdAt: '2024-01-01T00:00:00Z',
      updatedAt: '2024-01-01T00:00:00Z',
    };

    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        authContext: null,
        body: '{"targetStatus":"IN_PROGRESS","roomId":"room-1"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 400 when targetStatus is missing', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"roomId":"room-1"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: targetStatus' });
    });

    it('returns 400 when targetStatus is invalid', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"INVALID","roomId":"room-1"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when roomId is missing', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"IN_PROGRESS"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: roomId' });
    });

    it('returns 404 when thread not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: null });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"IN_PROGRESS","roomId":"room-1"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });

    it('returns 400 for invalid transition (DRAFT → DECIDED)', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({
        ok: false,
        error: { kind: 'INVALID_TRANSITION', from: 'DRAFT', to: 'DECIDED', validTargets: ['IN_PROGRESS'] },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"DECIDED","roomId":"room-1"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      const body = parseBody(response as { body: string }) as { validTargets: string[] };
      expect(body.validTargets).toEqual(['IN_PROGRESS']);
    });

    it('returns 200 with updated thread on successful transition', async () => {
      const updatedThread = {
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Test Thread',
        status: 'IN_PROGRESS',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({ ok: true, value: updatedThread as never });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"IN_PROGRESS","roomId":"room-1"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(parseBody(response as { body: string })).toEqual(updatedThread);
    });

    it('returns 503 when write-before-acknowledge fails', async () => {
      const updatedThread = {
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'Test Thread',
        status: 'IN_PROGRESS',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-02T00:00:00Z',
      };

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 },
      });
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(transition).mockReturnValue({ ok: true, value: updatedThread as never });
      vi.mocked(putItem).mockResolvedValue({ ok: false, error: { kind: 'WRITE_FAILURE', cause: 'Network error' } });

      const event = makeEvent({
        method: 'POST',
        path: '/threads/thread-1/transition',
        pathParameters: { id: 'thread-1' },
        body: '{"targetStatus":"IN_PROGRESS","roomId":"room-1"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'GET', path: '/threads/123' });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });
});
