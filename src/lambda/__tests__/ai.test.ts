/**
 * Unit tests for the AI Lambda handler (POST /threads/:id/messages).
 * Tests routing, auth, write-before-ack, AI interaction wiring, and error mapping.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { handler } from '../ai';

// Mock dependencies
vi.mock('@/lib/ai-architect', () => ({
  assessInputSufficiency: vi.fn(),
  proposeOptionsWithFallback: vi.fn(),
  regenerateTradeoffTable: vi.fn(),
}));

vi.mock('@/lib/decision-journal', () => ({
  indexEntity: vi.fn(),
}));

vi.mock('@/services/dynamo', () => ({
  putItem: vi.fn(),
  query: vi.fn(),
  getItem: vi.fn(),
}));

vi.mock('uuid', () => ({
  v4: vi.fn(() => 'test-uuid-1234'),
}));

import { assessInputSufficiency, proposeOptionsWithFallback, regenerateTradeoffTable } from '@/lib/ai-architect';
import { indexEntity } from '@/lib/decision-journal';
import { putItem, query, getItem } from '@/services/dynamo';

// =============================================================================
// Test Helpers
// =============================================================================

function makeEvent(overrides: {
  method?: string;
  path?: string;
  pathParameters?: Record<string, string>;
  authContext?: { userId: string; email: string; teams: string } | null;
  body?: string;
}): APIGatewayProxyEventV2 {
  const method = overrides.method ?? 'POST';
  const path = overrides.path ?? '/threads/thread-1/messages';
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
    pathParameters: overrides.pathParameters ?? { id: 'thread-1' },
    body: overrides.body,
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function parseBody(response: { body?: string }): unknown {
  return JSON.parse(response.body ?? '{}');
}

const mockThreadItem = {
  PK: 'ROOM#room-1',
  SK: 'THREAD#thread-1',
  GSI1PK: 'ROOM#room-1',
  GSI1SK: 'STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00Z',
  entityType: 'THREAD' as const,
  threadId: 'thread-1',
  roomId: 'room-1',
  title: 'API Gateway Design',
  status: 'IN_PROGRESS' as const,
  createdBy: 'user-123',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

// =============================================================================
// Tests
// =============================================================================

describe('AI Lambda Handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: indexEntity resolves successfully
    vi.mocked(indexEntity).mockResolvedValue({ ok: true, value: { embedding: [] } });
  });

  describe('POST /threads/:id/messages — Authorization', () => {
    it('returns 401 when no auth context is present', async () => {
      const event = makeEvent({
        authContext: null,
        body: JSON.stringify({ content: 'Hello', roomId: 'room-1' }),
      });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(401);
    });

    it('returns 403 when user has no team assignments', async () => {
      const event = makeEvent({
        authContext: { userId: 'user-1', email: 'u@e.com', teams: '[]' },
        body: JSON.stringify({ content: 'Hello', roomId: 'room-1' }),
      });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(403);
    });
  });

  describe('POST /threads/:id/messages — Validation', () => {
    it('returns 400 for invalid JSON body', async () => {
      const event = makeEvent({ body: 'not-json' });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toEqual({ error: 'Invalid JSON body' });
    });

    it('returns 400 when content is missing', async () => {
      const event = makeEvent({ body: JSON.stringify({ roomId: 'room-1' }) });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toMatchObject({ error: expect.stringContaining('content') });
    });

    it('returns 400 when roomId is missing', async () => {
      const event = makeEvent({ body: JSON.stringify({ content: 'Hello' }) });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(400);
      expect(parseBody(response as { body: string })).toMatchObject({ error: expect.stringContaining('roomId') });
    });

    it('returns 404 when thread does not exist', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: null });

      const event = makeEvent({ body: JSON.stringify({ content: 'Hello', roomId: 'room-1' }) });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(404);
    });
  });

  describe('POST /threads/:id/messages — Write-before-acknowledge', () => {
    it('returns 503 when user message persistence fails', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValueOnce({
        ok: false,
        error: { kind: 'WRITE_FAILURE', cause: 'DDB unavailable' },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Hello', roomId: 'room-1' }) });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(503);
      expect(parseBody(response as { body: string })).toMatchObject({
        error: expect.stringContaining('persist'),
      });
    });

    it('persists user message before invoking AI', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: true,
        value: { sufficient: true },
      });
      vi.mocked(proposeOptionsWithFallback).mockResolvedValue({
        ok: true,
        value: {
          kind: 'multiple_options',
          proposal: {
            options: [
              { summary: 'Option A', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
              { summary: 'Option B', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'High' },
            ],
            tradeoffTable: { options: ['A', 'B'], constraints: ['cost'], ratings: [['Good'], ['Bad']] },
          },
        },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Design an API', roomId: 'room-1' }) });
      await handler(event);

      // putItem should be called at least once for the user message (before AI)
      expect(putItem).toHaveBeenCalled();
      const firstCall = vi.mocked(putItem).mock.calls[0];
      const item = (firstCall[0] as { item: Record<string, unknown> }).item;
      expect(item.sender).toBe('user-123');
      expect(item.content).toBe('Design an API');
    });

    it('returns 503 when AI response persistence fails', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      // First putItem succeeds (user message), second fails (AI response)
      vi.mocked(putItem)
        .mockResolvedValueOnce({ ok: true, value: {} as never })
        .mockResolvedValueOnce({ ok: false, error: { kind: 'WRITE_FAILURE', cause: 'DDB failed' } });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: true,
        value: { sufficient: true },
      });
      vi.mocked(proposeOptionsWithFallback).mockResolvedValue({
        ok: true,
        value: {
          kind: 'multiple_options',
          proposal: {
            options: [
              { summary: 'A', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
              { summary: 'B', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'Medium' },
            ],
            tradeoffTable: { options: ['A', 'B'], constraints: ['perf'], ratings: [['Good'], ['Fair']] },
          },
        },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Design an API', roomId: 'room-1' }) });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(503);
      expect(parseBody(response as { body: string })).toMatchObject({
        error: expect.stringContaining('AI response'),
      });
    });
  });

  describe('POST /threads/:id/messages — AI Interaction Wiring', () => {
    it('calls assessInputSufficiency for first messages and returns clarifying questions', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] }); // No existing messages

      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: true,
        value: {
          sufficient: false,
          questions: [
            { question: 'What is your expected scale?', relevance: 'Needed to evaluate horizontal vs vertical scaling options' },
          ],
        },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'I need a messaging system', roomId: 'room-1' }) });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(200);
      expect(assessInputSufficiency).toHaveBeenCalled();

      const body = parseBody(response as { body: string }) as { messages: { sender: string; structuredData?: { type: string } }[] };
      expect(body.messages).toHaveLength(2);
      expect(body.messages[0].sender).toBe('user-123');
      expect(body.messages[1].sender).toBe('ai_architect');
      expect(body.messages[1].structuredData?.type).toBe('clarifying_questions');
    });

    it('calls proposeOptionsWithFallback when context is sufficient', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });

      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: true,
        value: { sufficient: true },
      });
      vi.mocked(proposeOptionsWithFallback).mockResolvedValue({
        ok: true,
        value: {
          kind: 'multiple_options',
          proposal: {
            options: [
              { summary: 'REST API', benefits: ['Simple', 'Standard'], risks: ['Overhead', 'Versioning'], complexity: 'Low' },
              { summary: 'GraphQL', benefits: ['Flexible', 'Typed'], risks: ['Complex', 'Caching'], complexity: 'Medium' },
            ],
            tradeoffTable: {
              options: ['REST', 'GraphQL'],
              constraints: ['simplicity', 'flexibility'],
              ratings: [['High', 'Low'], ['Low', 'High']],
            },
          },
        },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Design an API for 1000 users, deployed to AWS, team of 5, using Node.js', roomId: 'room-1' }) });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(200);
      expect(proposeOptionsWithFallback).toHaveBeenCalled();

      const body = parseBody(response as { body: string }) as { messages: { sender: string; structuredData?: { type: string } }[] };
      expect(body.messages[1].structuredData?.type).toBe('options');
    });

    it('calls regenerateTradeoffTable when newConstraints and previousTable are provided', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });

      const previousTable = {
        options: ['A', 'B'],
        constraints: ['cost'],
        ratings: [['Good'], ['Bad']],
      };

      vi.mocked(regenerateTradeoffTable).mockResolvedValue({
        ok: true,
        value: {
          table: {
            options: ['A', 'B'],
            constraints: ['cost', 'latency'],
            ratings: [['Good', 'Fair'], ['Bad', 'Good']],
          },
          changes: [
            { optionId: 'B', field: 'tradeoff_rating', constraintName: 'latency', previousValue: 'N/A', newValue: 'Good', reason: 'Option B uses async processing' },
          ],
        },
      });

      const event = makeEvent({
        body: JSON.stringify({
          content: 'We also need low latency',
          roomId: 'room-1',
          newConstraints: ['latency must be under 100ms'],
          previousTable,
        }),
      });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(200);
      expect(regenerateTradeoffTable).toHaveBeenCalledWith(expect.objectContaining({
        previousTable,
        newConstraints: ['latency must be under 100ms'],
      }));

      const body = parseBody(response as { body: string }) as { messages: { structuredData?: { type: string } }[] };
      expect(body.messages[1].structuredData?.type).toBe('tradeoff_table');
    });

    it('maps AI errors to 503', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });

      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: false,
        error: { kind: 'BEDROCK_INVOCATION_FAILURE', cause: 'Model unavailable' },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Hello', roomId: 'room-1' }) });
      const response = await handler(event);

      expect((response as { statusCode: number }).statusCode).toBe(503);
      expect(parseBody(response as { body: string })).toMatchObject({
        error: expect.stringContaining('AI service'),
      });
    });
  });

  describe('POST /threads/:id/messages — Embedding Indexing', () => {
    it('calls indexEntity after successful message exchange', async () => {
      vi.mocked(getItem).mockResolvedValue({ ok: true, value: mockThreadItem });
      vi.mocked(putItem).mockResolvedValue({ ok: true, value: {} as never });
      vi.mocked(query).mockResolvedValue({ ok: true, value: [] });
      vi.mocked(assessInputSufficiency).mockResolvedValue({
        ok: true,
        value: { sufficient: true },
      });
      vi.mocked(proposeOptionsWithFallback).mockResolvedValue({
        ok: true,
        value: {
          kind: 'multiple_options',
          proposal: {
            options: [
              { summary: 'A', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
              { summary: 'B', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'High' },
            ],
            tradeoffTable: { options: ['A', 'B'], constraints: ['speed'], ratings: [['Fast'], ['Slow']] },
          },
        },
      });

      const event = makeEvent({ body: JSON.stringify({ content: 'Design something', roomId: 'room-1' }) });
      await handler(event);

      // indexEntity should be called with the thread info
      expect(indexEntity).toHaveBeenCalledWith(expect.objectContaining({
        roomId: 'room-1',
        entityId: 'thread-1',
        entityType: 'THREAD',
      }));
    });
  });

  describe('Routing', () => {
    it('returns 404 for unknown routes', async () => {
      const event = makeEvent({ method: 'GET', path: '/threads/thread-1/messages' });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(404);
    });

    it('returns 404 for non-matching paths', async () => {
      const event = makeEvent({ method: 'POST', path: '/unknown' });
      const response = await handler(event);
      expect((response as { statusCode: number }).statusCode).toBe(404);
    });
  });
});
