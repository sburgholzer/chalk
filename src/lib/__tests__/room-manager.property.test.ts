import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';
import { validateRoomName } from '@/lib/room-manager';

/**
 * Property 1: Room creation invariants
 *
 * For any string 1-100 chars, `createRoom` produces a Room with unique non-empty ID,
 * exact given name, valid ISO 8601 timestamp, threadCount of 0, and correct team association.
 *
 * **Validates: Requirements 1.1, 1.2**
 *
 * Property 17: Team-scoped room access
 *
 * For any Room associated with teamId T, a user in team T gets access,
 * and a user NOT in team T is denied.
 *
 * **Validates: Requirements 10.3, 10.4**
 */

// Mock the AWS SDK
const mockSend = vi.hoisted(() => vi.fn());

vi.mock('@aws-sdk/client-dynamodb', () => ({
  DynamoDBClient: vi.fn(() => ({})),
}));

vi.mock('@aws-sdk/lib-dynamodb', () => ({
  DynamoDBDocumentClient: {
    from: () => ({ send: mockSend }),
  },
  PutCommand: vi.fn((input) => ({ input })),
  GetCommand: vi.fn((input) => ({ input })),
  QueryCommand: vi.fn((input) => ({ input })),
}));

import { createRoom, getRoom } from '@/lib/room-manager';
import type { RoomId, TeamId } from '@/types/domain';

describe('Property 1: Room creation invariants', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('for any valid name (1-100 chars), createRoom produces a Room with unique non-empty ID, exact name, valid ISO 8601 timestamp, threadCount 0, and correct team association', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0 && s.trim().length <= 100),
        fc.uuid(),
        async (name, teamIdStr) => {
          mockSend.mockReset();

          const teamId = teamIdStr as TeamId;

          // Mock query to return empty array (no duplicates)
          mockSend.mockImplementation((command) => {
            if (command.input?.TableName && command.input?.KeyConditionExpression) {
              // Query command - return empty (no duplicate rooms)
              return Promise.resolve({ Items: [] });
            }
            // PutCommand - succeed
            return Promise.resolve({});
          });

          const result = await createRoom({
            name,
            teamId,
            createdBy: 'user-123',
          });

          // Must succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const room = result.value;

          // Non-empty unique roomId
          expect(room.roomId).toBeDefined();
          expect(room.roomId.length).toBeGreaterThan(0);

          // Name matches exactly (trimmed)
          expect(room.name).toBe(name.trim());

          // Valid ISO 8601 createdAt timestamp
          const parsedDate = new Date(room.createdAt);
          expect(parsedDate.toISOString()).toBe(room.createdAt);
          expect(Number.isNaN(parsedDate.getTime())).toBe(false);

          // threadCount is 0
          expect(room.threadCount).toBe(0);

          // teamId matches provided teamId
          expect(room.teamId).toBe(teamId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('each invocation produces a distinct roomId (uniqueness)', async () => {
    const seenIds = new Set<string>();

    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0 && s.trim().length <= 100),
        async (name) => {
          mockSend.mockReset();

          // Mock query to return empty array (no duplicates)
          mockSend.mockImplementation((command) => {
            if (command.input?.TableName && command.input?.KeyConditionExpression) {
              return Promise.resolve({ Items: [] });
            }
            return Promise.resolve({});
          });

          const result = await createRoom({
            name,
            teamId: 'team-fixed' as TeamId,
            createdBy: 'user-123',
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Each roomId should be unique across all invocations
          expect(seenIds.has(result.value.roomId)).toBe(false);
          seenIds.add(result.value.roomId);
        },
      ),
      { numRuns: 100 },
    );
  });
});

/**
 * Property 2: Invalid room name rejection
 *
 * For any empty, whitespace-only, or >100 char string, `validateRoomName`
 * returns appropriate error Result.
 *
 * **Validates: Requirements 1.5**
 */
describe('Property 2: Invalid room name rejection', () => {
  it('empty string returns EMPTY_NAME error', () => {
    const result = validateRoomName('');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('EMPTY_NAME');
    }
  });

  it('whitespace-only strings return EMPTY_NAME error', () => {
    fc.assert(
      fc.property(
        fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 200 }),
        (whitespaceStr) => {
          const result = validateRoomName(whitespaceStr);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('EMPTY_NAME');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('strings exceeding 100 characters (after trim) return NAME_TOO_LONG error with maxLength=100', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 101, maxLength: 300 }).filter((s) => s.trim().length > 100),
        (longStr) => {
          const result = validateRoomName(longStr);
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('NAME_TOO_LONG');
            expect(result.error).toHaveProperty('maxLength', 100);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('Property 17: Team-scoped room access', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  it('getRoom returns ok for the correct team and NOT_FOUND for a different team', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 36 }),  // roomId
        fc.string({ minLength: 1, maxLength: 36 }),  // teamId (correct team)
        fc.string({ minLength: 1, maxLength: 36 }),  // otherTeamId (wrong team)
        async (roomId, teamId, otherTeamId) => {
          // Ensure teamId and otherTeamId are distinct
          fc.pre(teamId !== otherTeamId);

          const roomItem = {
            PK: `TEAM#${teamId}`,
            SK: `ROOM#${roomId}`,
            entityType: 'ROOM',
            roomId,
            teamId,
            name: 'Test Room',
            createdBy: 'user-1',
            createdAt: '2024-01-01T00:00:00.000Z',
            threadCount: 0,
          };

          // Mock DynamoDB: return room for correct team PK, null for wrong team PK
          mockSend.mockImplementation((command: { input: { Key: { PK: string; SK: string } } }) => {
            const key = command.input?.Key;
            if (key && key.PK === `TEAM#${teamId}` && key.SK === `ROOM#${roomId}`) {
              return Promise.resolve({ Item: roomItem });
            }
            // Wrong team or non-matching key → no item found
            return Promise.resolve({ Item: undefined });
          });

          // Access with correct team should succeed
          const okResult = await getRoom(roomId as RoomId, teamId as TeamId);
          expect(okResult.ok).toBe(true);
          if (okResult.ok) {
            expect(okResult.value.roomId).toBe(roomId);
            expect(okResult.value.teamId).toBe(teamId);
          }

          // Access with wrong team should return NOT_FOUND
          const errResult = await getRoom(roomId as RoomId, otherTeamId as TeamId);
          expect(errResult.ok).toBe(false);
          if (!errResult.ok) {
            expect(errResult.error.kind).toBe('NOT_FOUND');
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
