import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DecisionThread, ThreadId, RoomId, Option } from '@/types/domain';

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

import {
  createThread,
  canTransition,
  transition,
  VALID_TRANSITIONS,
} from '@/lib/thread-lifecycle';

describe('Thread Lifecycle', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('VALID_TRANSITIONS', () => {
    it('defines DRAFT can transition to IN_PROGRESS only', () => {
      expect(VALID_TRANSITIONS.DRAFT).toEqual(['IN_PROGRESS']);
    });

    it('defines IN_PROGRESS can transition to DECIDED only', () => {
      expect(VALID_TRANSITIONS.IN_PROGRESS).toEqual(['DECIDED']);
    });

    it('defines DECIDED can transition to IN_PROGRESS or SUPERSEDED', () => {
      expect(VALID_TRANSITIONS.DECIDED).toEqual(['IN_PROGRESS', 'SUPERSEDED']);
    });

    it('defines SUPERSEDED has no valid transitions', () => {
      expect(VALID_TRANSITIONS.SUPERSEDED).toEqual([]);
    });
  });

  describe('canTransition', () => {
    it('returns true for DRAFT → IN_PROGRESS', () => {
      expect(canTransition('DRAFT', 'IN_PROGRESS')).toBe(true);
    });

    it('returns true for IN_PROGRESS → DECIDED', () => {
      expect(canTransition('IN_PROGRESS', 'DECIDED')).toBe(true);
    });

    it('returns true for DECIDED → IN_PROGRESS', () => {
      expect(canTransition('DECIDED', 'IN_PROGRESS')).toBe(true);
    });

    it('returns true for DECIDED → SUPERSEDED', () => {
      expect(canTransition('DECIDED', 'SUPERSEDED')).toBe(true);
    });

    it('returns false for DRAFT → DECIDED (skipping IN_PROGRESS)', () => {
      expect(canTransition('DRAFT', 'DECIDED')).toBe(false);
    });

    it('returns false for SUPERSEDED → any status', () => {
      expect(canTransition('SUPERSEDED', 'DRAFT')).toBe(false);
      expect(canTransition('SUPERSEDED', 'IN_PROGRESS')).toBe(false);
      expect(canTransition('SUPERSEDED', 'DECIDED')).toBe(false);
    });

    it('returns false for IN_PROGRESS → DRAFT (backward)', () => {
      expect(canTransition('IN_PROGRESS', 'DRAFT')).toBe(false);
    });
  });

  describe('createThread', () => {
    it('creates a thread with DRAFT status and persists to DynamoDB', async () => {
      mockSend.mockResolvedValueOnce({});

      const result = await createThread({
        roomId: 'room-123' as RoomId,
        title: 'Choose a database strategy',
        createdBy: 'user-456',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('DRAFT');
        expect(result.value.title).toBe('Choose a database strategy');
        expect(result.value.roomId).toBe('room-123');
        expect(result.value.createdBy).toBe('user-456');
        expect(result.value.threadId).toBeTruthy();
        expect(result.value.createdAt).toBeTruthy();
        expect(result.value.updatedAt).toBe(result.value.createdAt);
      }
    });

    it('generates a unique thread ID', async () => {
      mockSend.mockResolvedValue({});

      const result1 = await createThread({
        roomId: 'room-1' as RoomId,
        title: 'Thread A',
        createdBy: 'user-1',
      });
      const result2 = await createThread({
        roomId: 'room-1' as RoomId,
        title: 'Thread B',
        createdBy: 'user-1',
      });

      expect(result1.ok && result2.ok).toBe(true);
      if (result1.ok && result2.ok) {
        expect(result1.value.threadId).not.toBe(result2.value.threadId);
      }
    });

    it('returns PERSISTENCE_FAILURE when DynamoDB write fails', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network timeout'));

      const result = await createThread({
        roomId: 'room-1' as RoomId,
        title: 'Test thread',
        createdBy: 'user-1',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('PERSISTENCE_FAILURE');
      }
    });
  });

  describe('transition', () => {
    const makeThread = (overrides?: Partial<DecisionThread>): DecisionThread => ({
      threadId: 'thread-1' as ThreadId,
      roomId: 'room-1' as RoomId,
      title: 'Test thread',
      status: 'DRAFT',
      createdBy: 'user-1',
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-01T00:00:00.000Z',
      ...overrides,
    });

    it('transitions DRAFT → IN_PROGRESS and updates timestamp', () => {
      const thread = makeThread({ status: 'DRAFT' });

      const result = transition(thread, 'IN_PROGRESS');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('IN_PROGRESS');
        expect(result.value.updatedAt).not.toBe(thread.updatedAt);
      }
    });

    it('transitions IN_PROGRESS → DECIDED and records selected option', () => {
      const thread = makeThread({ status: 'IN_PROGRESS' });
      const option: Option = {
        summary: 'Use DynamoDB single-table design',
        benefits: ['Low latency', 'Cost effective'],
        risks: ['Complex queries', 'Learning curve'],
        complexity: 'Medium',
      };

      const result = transition(thread, 'DECIDED', { selectedOption: option });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('DECIDED');
        expect(result.value.selectedOption).toBe('Use DynamoDB single-table design');
      }
    });

    it('transitions DECIDED → IN_PROGRESS and appends reopen marker', () => {
      const thread = makeThread({ status: 'DECIDED' });

      const result = transition(thread, 'IN_PROGRESS', {
        reopenReason: 'New scaling requirements discovered',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('IN_PROGRESS');
        expect(result.value.reopenMarkers).toHaveLength(1);
        expect(result.value.reopenMarkers![0].reason).toBe('New scaling requirements discovered');
        expect(result.value.reopenMarkers![0].timestamp).toBeTruthy();
      }
    });

    it('appends multiple reopen markers on repeated reopens', () => {
      const thread = makeThread({
        status: 'DECIDED',
        reopenMarkers: [{ timestamp: '2024-01-02T00:00:00.000Z', reason: 'First reopen' }],
      });

      const result = transition(thread, 'IN_PROGRESS', {
        reopenReason: 'Second reopen',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.reopenMarkers).toHaveLength(2);
        expect(result.value.reopenMarkers![0].reason).toBe('First reopen');
        expect(result.value.reopenMarkers![1].reason).toBe('Second reopen');
      }
    });

    it('transitions DECIDED → SUPERSEDED and records superseding thread ID', () => {
      const thread = makeThread({ status: 'DECIDED' });
      const newThreadId = 'thread-new' as ThreadId;

      const result = transition(thread, 'SUPERSEDED', { supersededBy: newThreadId });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.status).toBe('SUPERSEDED');
        expect(result.value.supersededBy).toBe('thread-new');
      }
    });

    it('rejects DRAFT → DECIDED (invalid transition)', () => {
      const thread = makeThread({ status: 'DRAFT' });

      const result = transition(thread, 'DECIDED');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_TRANSITION');
        expect(result.error.from).toBe('DRAFT');
        expect(result.error.to).toBe('DECIDED');
        expect(result.error.validTargets).toEqual(['IN_PROGRESS']);
      }
    });

    it('rejects SUPERSEDED → any transition', () => {
      const thread = makeThread({ status: 'SUPERSEDED' });

      const result = transition(thread, 'IN_PROGRESS');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INVALID_TRANSITION');
        expect(result.error.from).toBe('SUPERSEDED');
        expect(result.error.validTargets).toEqual([]);
      }
    });

    it('uses default reopen reason when none provided', () => {
      const thread = makeThread({ status: 'DECIDED' });

      const result = transition(thread, 'IN_PROGRESS');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.reopenMarkers![0].reason).toBe('Reopened for reconsideration');
      }
    });
  });
});
