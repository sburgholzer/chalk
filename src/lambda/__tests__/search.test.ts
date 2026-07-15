/**
 * Unit tests for the Search Lambda handler.
 * Tests the routing, authorization, error mapping, and integration
 * with the decision journal semantic search.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../search';

// Mock domain modules
vi.mock('@/lib/decision-journal', () => ({
  semanticSearch: vi.fn(),
}));

vi.mock('@/lib/room-manager', () => ({
  getRoom: vi.fn(),
}));

import { semanticSearch } from '@/lib/decision-journal';
import { getRoom } from '@/lib/room-manager';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: Partial<APIGatewayProxyEventV2> & {
  method?: string;
  path?: string;
  authContext?: { userId: string; email: string; teams: string } | null;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/rooms/room-1/search';
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

describe('Search Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('POST /rooms/:id/search — Semantic Search', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        authContext: null,
        body: '{"query":"database migration"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(401);
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        authContext: { userId: 'u1', email: 'u@e.com', teams: '[]' },
        body: '{"query":"database"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(403);
    });

    it('returns 400 when query is missing', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 } as never,
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Missing required field: query' });
    });

    it('returns 400 when filter status is invalid', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 } as never,
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"test","filters":{"status":"INVALID_STATUS"}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
    });

    it('returns 400 when dateRange is invalid', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 } as never,
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"test","filters":{"dateRange":{"from":"not-a-date","to":"also-not-a-date"}}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Invalid date range format. Use ISO 8601 dates.' });
    });

    it('returns 400 when dateRange from is after to', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 0 } as never,
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"test","filters":{"dateRange":{"from":"2024-12-01T00:00:00Z","to":"2024-01-01T00:00:00Z"}}}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'dateRange.from must be before dateRange.to' });
    });

    it('returns 200 with search results on success', async () => {
      const mockResults = [
        {
          threadId: 'thread-1',
          title: 'Database Strategy',
          status: 'DECIDED',
          date: '2024-01-02T00:00:00Z',
          similarityScore: 0.85,
          summary: 'Chose DynamoDB for scalability',
        },
      ];

      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(semanticSearch).mockResolvedValue({ ok: true, value: mockResults as never });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"database migration strategy"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      const body = parseBody(response as { body: string }) as { results: typeof mockResults };
      expect(body.results).toHaveLength(1);
      expect(body.results[0].title).toBe('Database Strategy');
      expect(semanticSearch).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        query: 'database migration strategy',
      }));
    });

    it('passes filters to semanticSearch correctly', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(semanticSearch).mockResolvedValue({ ok: true, value: [] });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"caching","filters":{"status":"DECIDED","title":"Redis"},"limit":10,"minSimilarity":0.8}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(200);
      expect(semanticSearch).toHaveBeenCalledWith({
        roomId: 'room-1',
        query: 'caching',
        filters: {
          status: 'DECIDED',
          dateRange: undefined,
          title: 'Redis',
        },
        limit: 10,
        minSimilarity: 0.8,
      });
    });

    it('returns 503 when search times out', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(semanticSearch).mockResolvedValue({
        ok: false,
        error: { kind: 'TIMEOUT', elapsedMs: 2000 },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"complex search"}',
      });
      const response = await handler(event);

      expect(response.statusCode).toBe(503);
      const body = parseBody(response as { body: string }) as { error: string };
      expect(body.error).toContain('timed out');
    });

    it('returns 400 when semanticSearch returns EMPTY_QUERY', async () => {
      vi.mocked(getRoom).mockResolvedValue({
        ok: true,
        value: { roomId: 'room-1', teamId: 'team-abc', name: 'R', createdBy: 'u', createdAt: '2024-01-01T00:00:00Z', threadCount: 1 } as never,
      });
      vi.mocked(semanticSearch).mockResolvedValue({
        ok: false,
        error: { kind: 'EMPTY_QUERY' },
      });

      const event = makeEvent({
        method: 'POST',
        path: '/rooms/room-1/search',
        pathParameters: { id: 'room-1' },
        body: '{"query":"   "}',
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
        path: '/rooms/room-x/search',
        pathParameters: { id: 'room-x' },
        body: '{"query":"test"}',
      });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'GET', path: '/rooms/room-1/search' });
      const response = await handler(event);
      expect(response.statusCode).toBe(404);
    });
  });
});
