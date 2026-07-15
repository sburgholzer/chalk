import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 3: Thread creation produces DRAFT status
 *
 * For any valid Room and non-empty title string, calling `createThread`
 * SHALL produce a DecisionThread with status `DRAFT`, a unique non-empty
 * threadId, and the provided title.
 *
 * **Validates: Requirements 2.1**
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

import { createThread } from '@/lib/thread-lifecycle';
import type { RoomId } from '@/types/domain';

describe('Property 3: Thread creation produces DRAFT status', () => {
  beforeEach(() => {
    mockSend.mockReset();
    // Mock DynamoDB putItem to succeed
    mockSend.mockResolvedValue({});
  });

  it('createThread always produces a thread with DRAFT status, unique threadId, and the provided title/roomId/createdBy', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.string({ minLength: 1, maxLength: 200 }), // title
        fc.string({ minLength: 1, maxLength: 36 }),  // roomId
        fc.string({ minLength: 1, maxLength: 36 }),  // createdBy
        async (title, roomId, createdBy) => {
          const result = await createThread({
            roomId: roomId as RoomId,
            title,
            createdBy,
          });

          // Must succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const thread = result.value;

          // Status must be DRAFT
          expect(thread.status).toBe('DRAFT');

          // threadId must be non-empty
          expect(thread.threadId).toBeTruthy();
          expect(thread.threadId.length).toBeGreaterThan(0);

          // Title matches provided title
          expect(thread.title).toBe(title);

          // roomId matches provided roomId
          expect(thread.roomId).toBe(roomId);

          // createdBy matches provided createdBy
          expect(thread.createdBy).toBe(createdBy);

          // createdAt and updatedAt are valid ISO 8601 timestamps
          const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/;
          expect(thread.createdAt).toMatch(isoRegex);
          expect(thread.updatedAt).toMatch(isoRegex);

          // createdAt and updatedAt should be the same on creation
          expect(thread.createdAt).toBe(thread.updatedAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('multiple thread creations produce unique threadIds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(
          fc.record({
            title: fc.string({ minLength: 1, maxLength: 200 }),
            roomId: fc.string({ minLength: 1, maxLength: 36 }),
            createdBy: fc.string({ minLength: 1, maxLength: 36 }),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        async (threadParams) => {
          const threadIds: string[] = [];

          for (const params of threadParams) {
            const result = await createThread({
              roomId: params.roomId as RoomId,
              title: params.title,
              createdBy: params.createdBy,
            });

            expect(result.ok).toBe(true);
            if (result.ok) {
              threadIds.push(result.value.threadId);
            }
          }

          // All thread IDs should be unique
          const uniqueIds = new Set(threadIds);
          expect(uniqueIds.size).toBe(threadIds.length);
        },
      ),
      { numRuns: 50 },
    );
  });
});


/**
 * Property 4: Valid thread transitions produce correct state
 *
 * For any DecisionThread in a given status, applying a transition to a status
 * that exists in VALID_TRANSITIONS[currentStatus] SHALL succeed and produce a
 * thread with the target status and an updated timestamp. Specifically:
 * - DRAFT → IN_PROGRESS records a transition timestamp
 * - IN_PROGRESS → DECIDED records the selected option
 * - DECIDED → IN_PROGRESS appends a reopen marker with timestamp and reason
 * - DECIDED → SUPERSEDED stores the superseding thread's ID as a cross-reference
 *
 * **Validates: Requirements 2.2, 2.3, 2.4, 2.5**
 */

import { transition, VALID_TRANSITIONS } from '@/lib/thread-lifecycle';
import type { DecisionThread, ThreadId, ThreadStatus, Option } from '@/types/domain';

// ---------- Generators ----------

const threadStatusArb = fc.constantFrom<ThreadStatus>('DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED');

const isoDateArb = fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map(d => d.toISOString());

const optionArb: fc.Arbitrary<Option> = fc.record({
  summary: fc.string({ minLength: 1, maxLength: 200 }),
  benefits: fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 5 }),
  risks: fc.array(fc.string({ minLength: 1, maxLength: 100 }), { minLength: 2, maxLength: 5 }),
  complexity: fc.constantFrom<'Low' | 'Medium' | 'High'>('Low', 'Medium', 'High'),
});

const threadIdArb = fc.uuid().map(id => id as ThreadId);

const baseThreadArb = (status: ThreadStatus): fc.Arbitrary<DecisionThread> =>
  fc.record({
    threadId: threadIdArb,
    roomId: fc.uuid().map(id => id as unknown as import('@/types/domain').RoomId),
    title: fc.string({ minLength: 1, maxLength: 200 }),
    status: fc.constant(status),
    createdBy: fc.string({ minLength: 1, maxLength: 50 }),
    createdAt: isoDateArb,
    updatedAt: isoDateArb,
    selectedOption: status === 'DECIDED' ? fc.string({ minLength: 1, maxLength: 200 }) : fc.constant(undefined),
    reopenMarkers: fc.constant(undefined),
    supersededBy: fc.constant(undefined),
  }).map(t => {
    // Remove undefined fields to keep thread clean
    const thread: DecisionThread = {
      threadId: t.threadId,
      roomId: t.roomId,
      title: t.title,
      status: t.status,
      createdBy: t.createdBy,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };
    if (t.selectedOption !== undefined) thread.selectedOption = t.selectedOption;
    if (t.reopenMarkers !== undefined) thread.reopenMarkers = t.reopenMarkers;
    if (t.supersededBy !== undefined) thread.supersededBy = t.supersededBy;
    return thread;
  });

describe('Property 4: Valid thread transitions produce correct state', () => {
  it('DRAFT → IN_PROGRESS succeeds with correct status and updated timestamp', () => {
    fc.assert(
      fc.property(
        baseThreadArb('DRAFT'),
        (thread) => {
          const result = transition(thread, 'IN_PROGRESS');

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const updated = result.value;

          // Status should be IN_PROGRESS
          expect(updated.status).toBe('IN_PROGRESS');

          // updatedAt should have changed from original
          expect(updated.updatedAt).not.toBe(thread.updatedAt);

          // updatedAt should be a valid ISO 8601 timestamp
          expect(new Date(updated.updatedAt).toISOString()).toBe(updated.updatedAt);

          // Other fields remain unchanged
          expect(updated.threadId).toBe(thread.threadId);
          expect(updated.roomId).toBe(thread.roomId);
          expect(updated.title).toBe(thread.title);
          expect(updated.createdBy).toBe(thread.createdBy);
          expect(updated.createdAt).toBe(thread.createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('IN_PROGRESS → DECIDED records the selected option summary', () => {
    fc.assert(
      fc.property(
        baseThreadArb('IN_PROGRESS'),
        optionArb,
        (thread, selectedOption) => {
          const result = transition(thread, 'DECIDED', { selectedOption });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const updated = result.value;

          // Status should be DECIDED
          expect(updated.status).toBe('DECIDED');

          // updatedAt should have changed
          expect(updated.updatedAt).not.toBe(thread.updatedAt);

          // selectedOption should be set to the option's summary
          expect(updated.selectedOption).toBe(selectedOption.summary);

          // Other fields remain unchanged
          expect(updated.threadId).toBe(thread.threadId);
          expect(updated.roomId).toBe(thread.roomId);
          expect(updated.title).toBe(thread.title);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('DECIDED → IN_PROGRESS appends a reopen marker with timestamp and reason', () => {
    fc.assert(
      fc.property(
        baseThreadArb('DECIDED'),
        fc.string({ minLength: 1, maxLength: 200 }), // reopenReason
        (thread, reopenReason) => {
          const originalMarkers = thread.reopenMarkers ?? [];
          const result = transition(thread, 'IN_PROGRESS', { reopenReason });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const updated = result.value;

          // Status should be IN_PROGRESS
          expect(updated.status).toBe('IN_PROGRESS');

          // updatedAt should have changed
          expect(updated.updatedAt).not.toBe(thread.updatedAt);

          // reopenMarkers should have one more entry
          expect(updated.reopenMarkers).toBeDefined();
          expect(updated.reopenMarkers!.length).toBe(originalMarkers.length + 1);

          // The new marker should have the expected reason and a valid timestamp
          const lastMarker = updated.reopenMarkers![updated.reopenMarkers!.length - 1];
          expect(lastMarker.reason).toBe(reopenReason);
          expect(new Date(lastMarker.timestamp).toISOString()).toBe(lastMarker.timestamp);

          // Existing markers should be preserved
          for (let i = 0; i < originalMarkers.length; i++) {
            expect(updated.reopenMarkers![i]).toEqual(originalMarkers[i]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('DECIDED → SUPERSEDED stores the superseding thread ID', () => {
    fc.assert(
      fc.property(
        baseThreadArb('DECIDED'),
        threadIdArb, // supersededBy threadId
        (thread, supersedingThreadId) => {
          const result = transition(thread, 'SUPERSEDED', { supersededBy: supersedingThreadId });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const updated = result.value;

          // Status should be SUPERSEDED
          expect(updated.status).toBe('SUPERSEDED');

          // updatedAt should have changed
          expect(updated.updatedAt).not.toBe(thread.updatedAt);

          // supersededBy should be set to the provided thread ID
          expect(updated.supersededBy).toBe(supersedingThreadId);

          // Other fields remain unchanged
          expect(updated.threadId).toBe(thread.threadId);
          expect(updated.roomId).toBe(thread.roomId);
          expect(updated.title).toBe(thread.title);
        },
      ),
      { numRuns: 100 },
    );
  });
});


/**
 * Property 5: Invalid thread transitions are rejected
 *
 * For any thread with status S and target T NOT in VALID_TRANSITIONS[S],
 * calling `transition(thread, T)` SHALL return an error Result with kind
 * `INVALID_TRANSITION` containing the current status, attempted target,
 * and the list of valid target statuses from S.
 *
 * **Validates: Requirements 2.6**
 */

import { transition, VALID_TRANSITIONS } from '@/lib/thread-lifecycle';
import type { DecisionThread, ThreadId, ThreadStatus } from '@/types/domain';

describe('Property 5: Invalid thread transitions are rejected', () => {
  const ALL_STATUSES: ThreadStatus[] = ['DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];

  function makeThread(status: ThreadStatus): DecisionThread {
    return {
      threadId: 'thread-001' as ThreadId,
      roomId: 'room-001' as RoomId,
      title: 'Test Thread',
      status,
      createdBy: 'user-001',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
    };
  }

  it('for any source status S and invalid target T, transition returns INVALID_TRANSITION error with from, to, and validTargets', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES).chain((sourceStatus) => {
          const validTargets = VALID_TRANSITIONS[sourceStatus];
          const invalidTargets = ALL_STATUSES.filter((t) => !validTargets.includes(t));
          // Only generate if there are invalid targets for this source
          if (invalidTargets.length === 0) {
            // SUPERSEDED has no valid transitions so all targets are "invalid"
            // but actually for SUPERSEDED, ALL_STATUSES minus [] = ALL_STATUSES
            // This won't happen since SUPERSEDED has 0 valid, so all 4 are invalid
            return fc.constant([sourceStatus, sourceStatus] as [ThreadStatus, ThreadStatus]);
          }
          return fc.constantFrom(...invalidTargets).map(
            (target) => [sourceStatus, target] as [ThreadStatus, ThreadStatus],
          );
        }),
        ([sourceStatus, targetStatus]) => {
          const validTargets = VALID_TRANSITIONS[sourceStatus];

          // Ensure the target is truly invalid for this source
          if (validTargets.includes(targetStatus)) return;

          const thread = makeThread(sourceStatus);
          const result = transition(thread, targetStatus);

          // Result must be an error
          expect(result.ok).toBe(false);
          if (result.ok) return;

          const error = result.error;

          // Error kind must be INVALID_TRANSITION
          expect(error.kind).toBe('INVALID_TRANSITION');
          if (error.kind !== 'INVALID_TRANSITION') return;

          // Error contains the current status (from)
          expect(error.from).toBe(sourceStatus);

          // Error contains the attempted target (to)
          expect(error.to).toBe(targetStatus);

          // Error contains the valid targets list for the current status
          expect(error.validTargets).toEqual(VALID_TRANSITIONS[sourceStatus]);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('SUPERSEDED status rejects all transitions since it has no valid targets', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_STATUSES),
        (targetStatus) => {
          const thread = makeThread('SUPERSEDED');
          const result = transition(thread, targetStatus);

          // All transitions from SUPERSEDED are invalid
          expect(result.ok).toBe(false);
          if (result.ok) return;

          expect(result.error.kind).toBe('INVALID_TRANSITION');
          if (result.error.kind !== 'INVALID_TRANSITION') return;

          expect(result.error.from).toBe('SUPERSEDED');
          expect(result.error.to).toBe(targetStatus);
          expect(result.error.validTargets).toEqual([]);
        },
      ),
      { numRuns: 50 },
    );
  });
});
