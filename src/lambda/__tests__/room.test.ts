/**
 * Unit tests for the Room Lambda handler.
 * Tests the routing, authorization, error mapping, and integration
 * with the room-manager domain logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../room';

// Mock the room-manager module
vi.mock('@/lib/room-manager', () => ({
  createRoom: vi.fn(),
  getRoom: vi.fn(),
  listRoomsForTeam: vi.fn(),
}));

// Mock the dynamo service for thread queries
vi.mock('@/services/dynamo', () => ({
  query: vi.fn(),
}));

import { createRoom, getRoom, listRoomsForTeam } from '@/lib/room-manager';
import { query } from '@/services/dynamo';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  authContext?: { userId: string; email: string; teams: string } | null;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'GET';
  const path = overrides.path ?? '/rooms';
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

describe('Room Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /rooms — Create Room', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({ method: 'POST', path: '/rooms', authContext: null, body: '{"name":"Test"}' });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Unauthorized' });
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rooms',
        authContext: { userId: 'user-1', email: 'u@e.com', teams: '[]' },
        body: '{"name":"Test"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 for invalid JSON body', async () => {
      const event = makeEvent({ method: 'POST', path: '/rooms', body: 'not-json' });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 when name field is missing', async () => {
      const event = makeEvent({ method: 'POST', path: '/rooms', body: '{}' });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: name' });
    });

    it('returns 201 with room on successful creation', async () => {
      const mockRoom = {
        roomId: 'room-1',
        teamId: 'team-abc',
        name: 'My Room',
        createdBy: 'user-123',
        createdAt: '2024-01-01T00:00:00.000Z',
        threadCount: 0,
      };
      vi.mocked(createRoom).mockResolvedValue({ ok: true, value: mockRoom });

      const event = makeEvent({ method: 'POST', path: '/rooms', body: '{"name":"My Room"}' });
      const response = await handler(event);

      expect(response.statusCode).toBe(201);
      expect(parseBody(response as { body: string })).toEqual(mockRoom);
      expect(createRoom).toHaveBeenCalledWith({
        name: 'My Room',
        teamId: 'team-abc',
        createdBy: 'user-123',
      });
    });

    it('maps EMPTY_NAME error to 400', async () => {
      vi.mocked(createRoom).mockResolvedValue({ ok: false, error: { kind: 'EMPTY_NAME' } });

      const event = makeEvent({ method: 'POST', path: '/rooms', body: '{"name":"  "}' });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Room name cannot be empty' });
    });

    it('maps NAME_TOO_LONG error to 400', async () => {
      vi.mocked(createRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NAME_TOO_LONG', maxLength: 100 },
      });

      const event = makeEvent({ method: 'POST', path: '/rooms', body: '{"name":"x".repeat(101)}' });
      const response = await handler(event);

      expect(response.statusCode).toBe(400);
    });

    it('maps PERSISTENCE_FAILURE error to 503', async () => {
      vi.mocked(createRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'PERSISTENCE_FAILURE', cause: 'DDB unavailable' },
      });

      const event = makeEvent({ method: 'POST', path: '/rooms', body: '{"name":"Test"}' });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
    });
  });

  describe('GET /rooms — List Rooms', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({ method: 'GET', path: '/rooms', authContext: null });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 200 with rooms array on success', async () => {
      const mockRooms = [
        { roomId: 'r1', teamId: 'team-abc', name: 'Room 1', createdBy: 'u1', createdAt: '2024-01-01T00:00:00Z', threadCount: 2 },
      ];
      vi.mocked(listRoomsForTeam).mockResolvedValue({ ok: true, value: mockRooms });

      const event = makeEvent({ method: 'GET', path: '/rooms' });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(parseBody(response as { body: string })).toEqual({ rooms: mockRooms });
      expect(listRoomsForTeam).toHaveBeenCalledWith('team-abc');
    });
  });

  describe('GET /rooms/:id — Get Room with Threads', () => {
    it('returns 404 when room not found', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: false,
        error: { kind: 'NOT_FOUND', roomId: 'room-x' as never },
      });

      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-x',
        pathParameters: { id: 'room-x' },
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(404);
    });

    it('returns 200 with room and threads on success', async () => {
      const mockRoom = {
        roomId: 'room-1',
        teamId: 'team-abc',
        name: 'Room 1',
        createdBy: 'user-1',
        createdAt: '2024-01-01T00:00:00Z',
        threadCount: 1,
      };
      const mockThreads = [{
        PK: 'ROOM#room-1',
        SK: 'THREAD#thread-1',
        GSI1PK: 'ROOM#room-1',
        GSI1SK: 'STATUS#DRAFT#DATE#2024-01-01T00:00:00Z',
        entityType: 'THREAD' as const,
        threadId: 'thread-1',
        roomId: 'room-1',
        title: 'My Thread',
        status: 'DRAFT' as const,
        createdBy: 'user-1',
        createdAt: '2024-01-01T00:00:00Z',
        updatedAt: '2024-01-01T00:00:00Z',
      }];

      vi.mocked(getRoom).mockResolvedValue({ ok: true, value: mockRoom });
      vi.mocked(query).mockResolvedValue({ ok: true, value: mockThreads });

      const event = makeEvent({
        method: 'GET',
        path: '/rooms/room-1',
        pathParameters: { id: 'room-1' },
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = parseBody(response as { body: string }) as { room: unknown; threads: unknown[] };
      expect(body.room).toEqual(mockRoom);
      expect(body.threads).toHaveLength(1);
      expect((body.threads[0] as { title: string }).title).toBe('My Thread');
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'DELETE', path: '/rooms/123' });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });
});
