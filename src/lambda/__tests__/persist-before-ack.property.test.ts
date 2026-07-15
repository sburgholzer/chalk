/**
 * Property 25: Persist-before-acknowledge ordering
 *
 * For any message sent, the Lambda handler confirms DynamoDB persistence before
 * returning success; on write failure (after retries), returns error and client
 * does not display message as sent.
 *
 * **Validates: Requirements 9.2**
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import type { APIGatewayProxyEventV2 } from 'aws-lambda';

// =============================================================================
// Mocks
// =============================================================================

const mockPutItem = vi.hoisted(() => vi.fn());
const mockGetItem = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockCreateRoom = vi.hoisted(() => vi.fn());
const mockGetRoom = vi.hoisted(() => vi.fn());
const mockListRoomsForTeam = vi.hoisted(() => vi.fn());
const mockAssessInputSufficiency = vi.hoisted(() => vi.fn());
const mockProposeOptionsWithFallback = vi.hoisted(() => vi.fn());
const mockRegenerateTradeoffTable = vi.hoisted(() => vi.fn());
const mockIndexEntity = vi.hoisted(() => vi.fn());

vi.mock('@/services/dynamo', () => ({
  putItem: mockPutItem,
  getItem: mockGetItem,
  query: mockQuery,
  putItemWithRetry: vi.fn(),
}));

vi.mock('@/lib/room-manager', () => ({
  createRoom: mockCreateRoom,
  getRoom: mockGetRoom,
  listRoomsForTeam: mockListRoomsForTeam,
}));

vi.mock('@/lib/ai-architect', () => ({
  assessInputSufficiency: mockAssessInputSufficiency,
  proposeOptionsWithFallback: mockProposeOptionsWithFallback,
  regenerateTradeoffTable: mockRegenerateTradeoffTable,
}));

vi.mock('@/lib/decision-journal', () => ({
  indexEntity: mockIndexEntity,
}));

vi.mock('uuid', () => ({
  v4: () => 'mock-uuid-1234',
}));

import { handler as roomHandler } from '../room';
import { handler as aiHandler } from '../ai';

// =============================================================================
// Helpers
// =============================================================================

function makeRoomCreateEvent(name: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /rooms',
    rawPath: '/rooms',
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789',
      apiId: 'api-id',
      authorizer: {
        lambda: { userId: 'user-123', email: 'user@test.com', teams: '["team-abc"]' },
      },
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: '/rooms', protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-123',
      routeKey: 'POST /rooms',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    body: JSON.stringify({ name }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function makeMessageEvent(content: string, threadId: string, roomId: string): APIGatewayProxyEventV2 {
  return {
    version: '2.0',
    routeKey: 'POST /threads/:id/messages',
    rawPath: `/threads/${threadId}/messages`,
    rawQueryString: '',
    headers: {},
    requestContext: {
      accountId: '123456789',
      apiId: 'api-id',
      authorizer: {
        lambda: { userId: 'user-123', email: 'user@test.com', teams: '["team-abc"]' },
      },
      domainName: 'api.example.com',
      domainPrefix: 'api',
      http: { method: 'POST', path: `/threads/${threadId}/messages`, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 'test' },
      requestId: 'req-456',
      routeKey: 'POST /threads/:id/messages',
      stage: '$default',
      time: '01/Jan/2024:00:00:00 +0000',
      timeEpoch: 1704067200000,
    },
    pathParameters: { id: threadId },
    body: JSON.stringify({ content, roomId }),
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

/** Arbitrary for valid room names (1-100 non-empty chars). */
const arbRoomName = fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0);

/** Arbitrary for valid message content. */
const arbMessageContent = fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0);

/** Arbitrary for valid IDs (alphanumeric + hyphens). */
const arbId = fc.stringMatching(/^[a-z0-9-]{3,36}$/);

// =============================================================================
// Tests
// =============================================================================

describe('Property 25: Persist-before-acknowledge ordering', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIndexEntity.mockResolvedValue({ ok: true, value: undefined });
  });

  describe('Room creation: persistence success → 2xx response', () => {
    it('for any valid room name, when persistence succeeds, handler returns 201', async () => {
      await fc.assert(
        fc.asyncProperty(arbRoomName, async (name) => {
          mockCreateRoom.mockResolvedValue({
            ok: true,
            value: {
              roomId: 'room-gen-id',
              teamId: 'team-abc',
              name,
              createdBy: 'user-123',
              createdAt: new Date().toISOString(),
              threadCount: 0,
            },
          });

          const event = makeRoomCreateEvent(name);
          const response = await roomHandler(event);

          // When persistence succeeds, response MUST be 2xx (201 for creation)
          expect(response.statusCode).toBe(201);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Room creation: persistence failure → non-2xx response', () => {
    it('for any valid room name, when persistence fails, handler NEVER returns 2xx', async () => {
      await fc.assert(
        fc.asyncProperty(arbRoomName, async (name) => {
          mockCreateRoom.mockResolvedValue({
            ok: false,
            error: { kind: 'PERSISTENCE_FAILURE', cause: 'DynamoDB write failed' },
          });

          const event = makeRoomCreateEvent(name);
          const response = await roomHandler(event);

          // When persistence fails, response MUST NOT be 2xx
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.statusCode).toBeLessThan(600);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Message sending: persistence success → 2xx response', () => {
    it('for any valid message, when all DynamoDB writes succeed, handler returns 200', async () => {
      await fc.assert(
        fc.asyncProperty(arbMessageContent, arbId, arbId, async (content, threadId, roomId) => {
          // Thread exists
          mockGetItem.mockResolvedValue({
            ok: true,
            value: {
              PK: `ROOM#${roomId}`,
              SK: `THREAD#${threadId}`,
              entityType: 'THREAD',
              threadId,
              roomId,
              title: 'Test Thread',
              status: 'IN_PROGRESS',
              createdBy: 'user-123',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          });

          // Both user message and AI response writes succeed
          mockPutItem.mockResolvedValue({ ok: true, value: {} });

          // Conversation history query returns empty (first message)
          mockQuery.mockResolvedValue({ ok: true, value: [] });

          // AI returns clarifying questions (simplest response path)
          mockAssessInputSufficiency.mockResolvedValue({
            ok: true,
            value: {
              sufficient: true,
            },
          });

          mockProposeOptionsWithFallback.mockResolvedValue({
            ok: true,
            value: {
              kind: 'multiple_options',
              proposal: {
                options: [
                  { summary: 'Option A', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
                  { summary: 'Option B', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'Medium' },
                ],
                tradeoffTable: { constraints: ['perf'], options: ['A', 'B'], ratings: [['Good'], ['Fair']] },
              },
            },
          });

          const event = makeMessageEvent(content, threadId, roomId);
          const response = await aiHandler(event);

          // When all persistence operations succeed, response MUST be 2xx
          expect(response.statusCode).toBe(200);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Message sending: user message persistence failure → non-2xx response', () => {
    it('for any valid message, when user message DynamoDB write fails, handler NEVER returns 2xx', async () => {
      await fc.assert(
        fc.asyncProperty(arbMessageContent, arbId, arbId, async (content, threadId, roomId) => {
          // Thread exists
          mockGetItem.mockResolvedValue({
            ok: true,
            value: {
              PK: `ROOM#${roomId}`,
              SK: `THREAD#${threadId}`,
              entityType: 'THREAD',
              threadId,
              roomId,
              title: 'Test Thread',
              status: 'IN_PROGRESS',
              createdBy: 'user-123',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          });

          // First putItem call (user message) FAILS
          mockPutItem.mockResolvedValueOnce({
            ok: false,
            error: { kind: 'WRITE_FAILURE', cause: 'DynamoDB unavailable' },
          });

          const event = makeMessageEvent(content, threadId, roomId);
          const response = await aiHandler(event);

          // When user message persistence fails, response MUST NOT be 2xx
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.statusCode).toBe(503);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Message sending: AI response persistence failure → non-2xx response', () => {
    it('for any valid message, when AI response DynamoDB write fails, handler NEVER returns 2xx', async () => {
      await fc.assert(
        fc.asyncProperty(arbMessageContent, arbId, arbId, async (content, threadId, roomId) => {
          // Thread exists
          mockGetItem.mockResolvedValue({
            ok: true,
            value: {
              PK: `ROOM#${roomId}`,
              SK: `THREAD#${threadId}`,
              entityType: 'THREAD',
              threadId,
              roomId,
              title: 'Test Thread',
              status: 'IN_PROGRESS',
              createdBy: 'user-123',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            },
          });

          // First putItem call (user message) succeeds
          mockPutItem.mockResolvedValueOnce({ ok: true, value: {} });
          // Second putItem call (AI response) FAILS
          mockPutItem.mockResolvedValueOnce({
            ok: false,
            error: { kind: 'WRITE_FAILURE', cause: 'DynamoDB throttled' },
          });

          // Conversation history query
          mockQuery.mockResolvedValue({ ok: true, value: [] });

          // AI returns a response
          mockAssessInputSufficiency.mockResolvedValue({
            ok: true,
            value: { sufficient: true },
          });

          mockProposeOptionsWithFallback.mockResolvedValue({
            ok: true,
            value: {
              kind: 'multiple_options',
              proposal: {
                options: [
                  { summary: 'Option A', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
                  { summary: 'Option B', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'High' },
                ],
                tradeoffTable: { constraints: ['cost'], options: ['A', 'B'], ratings: [['Low'], ['High']] },
              },
            },
          });

          const event = makeMessageEvent(content, threadId, roomId);
          const response = await aiHandler(event);

          // When AI response persistence fails, response MUST NOT be 2xx
          expect(response.statusCode).toBeGreaterThanOrEqual(400);
          expect(response.statusCode).toBe(503);
        }),
        { numRuns: 50 },
      );
    });
  });

  describe('Universal invariant: persistence failure can NEVER produce success', () => {
    it('for any valid request, if ANY DynamoDB write fails, the response is never 2xx', async () => {
      await fc.assert(
        fc.asyncProperty(
          arbMessageContent,
          arbId,
          arbId,
          fc.integer({ min: 1, max: 2 }), // which write fails: 1 = user msg, 2 = AI response
          async (content, threadId, roomId, failingWriteIndex) => {
            // Thread exists
            mockGetItem.mockResolvedValue({
              ok: true,
              value: {
                PK: `ROOM#${roomId}`,
                SK: `THREAD#${threadId}`,
                entityType: 'THREAD',
                threadId,
                roomId,
                title: 'Test Thread',
                status: 'IN_PROGRESS',
                createdBy: 'user-123',
                createdAt: '2024-01-01T00:00:00.000Z',
                updatedAt: '2024-01-01T00:00:00.000Z',
              },
            });

            // Configure putItem based on which write should fail
            let callIndex = 0;
            mockPutItem.mockImplementation(() => {
              callIndex++;
              if (callIndex === failingWriteIndex) {
                return Promise.resolve({
                  ok: false,
                  error: { kind: 'WRITE_FAILURE', cause: 'Simulated failure' },
                });
              }
              return Promise.resolve({ ok: true, value: {} });
            });

            // Conversation history
            mockQuery.mockResolvedValue({ ok: true, value: [] });

            // AI response (only reached if user msg write succeeds)
            mockAssessInputSufficiency.mockResolvedValue({
              ok: true,
              value: { sufficient: true },
            });

            mockProposeOptionsWithFallback.mockResolvedValue({
              ok: true,
              value: {
                kind: 'multiple_options',
                proposal: {
                  options: [
                    { summary: 'Opt X', benefits: ['b1', 'b2'], risks: ['r1', 'r2'], complexity: 'Low' },
                    { summary: 'Opt Y', benefits: ['b3', 'b4'], risks: ['r3', 'r4'], complexity: 'Medium' },
                  ],
                  tradeoffTable: { constraints: ['scale'], options: ['X', 'Y'], ratings: [['High'], ['Med']] },
                },
              },
            });

            const event = makeMessageEvent(content, threadId, roomId);
            const response = await aiHandler(event);

            // THE INVARIANT: if ANY write failed, response is NEVER 2xx
            expect(response.statusCode).toBeGreaterThanOrEqual(400);
          },
        ),
        { numRuns: 100 },
      );
    });
  });
});
