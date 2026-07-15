import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createCrossReference,
  findRelatedDecisions,
  summarizeChangesSince,
  getReferencesForThread,
  cosineSimilarity,
} from './cross-reference';
import type { ThreadId, RoomId, ReferenceType } from '@/types/domain';

// Mock dependencies
vi.mock('@/services/dynamo', () => ({
  putItem: vi.fn(),
  query: vi.fn(),
}));

import { putItem, query } from '@/services/dynamo';

const mockedPutItem = vi.mocked(putItem);
const mockedQuery = vi.mocked(query);

// =============================================================================
// Test Helpers
// =============================================================================

function makeThreadId(id: string): ThreadId {
  return id as ThreadId;
}

function makeRoomId(id: string): RoomId {
  return id as RoomId;
}

// =============================================================================
// createCrossReference tests
// =============================================================================

describe('createCrossReference', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('rejects self-reference', async () => {
    const threadId = makeThreadId('thread-1');

    const result = await createCrossReference({
      sourceThreadId: threadId,
      targetThreadId: threadId,
      referenceType: 'DEPENDS_ON',
      description: 'Self dependency',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('SELF_REFERENCE');
    }
    expect(mockedPutItem).not.toHaveBeenCalled();
  });

  it('creates a cross-reference successfully', async () => {
    mockedQuery.mockResolvedValueOnce({ ok: true, value: [{ messageId: 'msg-1' }] });
    mockedPutItem.mockResolvedValueOnce({ ok: true, value: {} as never });

    const result = await createCrossReference({
      sourceThreadId: makeThreadId('thread-1'),
      targetThreadId: makeThreadId('thread-2'),
      referenceType: 'SUPERSEDES',
      description: 'Replaces prior database decision',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sourceThreadId).toBe('thread-1');
      expect(result.value.targetThreadId).toBe('thread-2');
      expect(result.value.referenceType).toBe('SUPERSEDES');
      expect(result.value.description).toBe('Replaces prior database decision');
      expect(result.value.createdAt).toBeDefined();
    }

    expect(mockedPutItem).toHaveBeenCalledWith({
      item: expect.objectContaining({
        PK: 'THREAD#thread-1',
        SK: 'XREF#thread-2',
        entityType: 'CROSS_REFERENCE',
        sourceThreadId: 'thread-1',
        targetThreadId: 'thread-2',
        referenceType: 'SUPERSEDES',
      }),
    });
  });

  it('returns PERSISTENCE_FAILURE on write failure', async () => {
    mockedQuery.mockResolvedValueOnce({ ok: true, value: [{ messageId: 'msg-1' }] });
    mockedPutItem.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'WRITE_FAILURE', cause: 'Network timeout' },
    });

    const result = await createCrossReference({
      sourceThreadId: makeThreadId('thread-1'),
      targetThreadId: makeThreadId('thread-2'),
      referenceType: 'CONTRADICTS',
      description: 'Contradicts previous caching strategy',
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('PERSISTENCE_FAILURE');
      expect(result.error.cause).toBe('Network timeout');
    }
  });
});

// =============================================================================
// findRelatedDecisions tests
// =============================================================================

describe('findRelatedDecisions', () => {
  it('returns ADRs above similarity threshold', () => {
    // Two vectors pointing in the same direction (cosine similarity = 1.0)
    const queryEmbedding = [1, 0, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'Use Kafka', context: 'Event streaming', embedding: [1, 0, 0] },
      { id: 'adr-2', title: 'Use REST', context: 'API design', embedding: [0, 1, 0] },
      { id: 'adr-3', title: 'Use gRPC', context: 'High perf API', embedding: [0.8, 0.6, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Choosing messaging system',
      existingADRs,
      queryEmbedding,
      similarityThreshold: 0.7,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // adr-1 should have score 1.0, adr-3 should have score 0.8 (above 0.7)
      // adr-2 should have score 0.0 (below 0.7)
      expect(result.value.length).toBe(2);
      expect(result.value[0].id).toBe('adr-1');
      expect(result.value[0].score).toBeCloseTo(1.0);
      expect(result.value[1].id).toBe('adr-3');
      expect(result.value[1].score).toBeCloseTo(0.8);
    }
  });

  it('returns empty array when no ADRs meet threshold', () => {
    const queryEmbedding = [1, 0, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'Unrelated', context: 'Other stuff', embedding: [0, 1, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Choosing messaging system',
      existingADRs,
      queryEmbedding,
      similarityThreshold: 0.7,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it('uses default threshold of 0.7 when not specified', () => {
    // Vector with cosine similarity ~0.6 (below default 0.7)
    const queryEmbedding = [1, 0, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'Somewhat related', context: 'Context', embedding: [0.6, 0.8, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Test',
      existingADRs,
      queryEmbedding,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // cos(1,0,0 . 0.6,0.8,0) = 0.6/1.0 = 0.6 which is below 0.7
      expect(result.value).toHaveLength(0);
    }
  });

  it('sorts results by score descending', () => {
    const queryEmbedding = [1, 1, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'A', context: 'ctx', embedding: [0.9, 0.8, 0] },
      { id: 'adr-2', title: 'B', context: 'ctx', embedding: [1, 1, 0] },
      { id: 'adr-3', title: 'C', context: 'ctx', embedding: [0.7, 0.9, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Test',
      existingADRs,
      queryEmbedding,
      similarityThreshold: 0.9,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      for (let i = 1; i < result.value.length; i++) {
        expect(result.value[i - 1].score).toBeGreaterThanOrEqual(result.value[i].score);
      }
    }
  });

  it('skips ADRs with empty embeddings', () => {
    const queryEmbedding = [1, 0, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'No embedding', context: 'ctx', embedding: [] },
      { id: 'adr-2', title: 'Good', context: 'ctx', embedding: [1, 0, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Test',
      existingADRs,
      queryEmbedding,
      similarityThreshold: 0.7,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].id).toBe('adr-2');
    }
  });

  it('includes relevance descriptions in results', () => {
    const queryEmbedding = [1, 0, 0];
    const existingADRs = [
      { id: 'adr-1', title: 'Use Kafka', context: 'Event streaming decision', embedding: [1, 0, 0] },
    ];

    const result = findRelatedDecisions({
      roomId: makeRoomId('room-1'),
      currentThreadId: makeThreadId('thread-1'),
      threadContent: 'Messaging',
      existingADRs,
      queryEmbedding,
      similarityThreshold: 0.7,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value[0].relevance).toBeTruthy();
      expect(typeof result.value[0].relevance).toBe('string');
    }
  });
});

// =============================================================================
// cosineSimilarity tests
// =============================================================================

describe('cosineSimilarity', () => {
  it('returns 1 for identical vectors', () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1.0);
  });

  it('returns 0 for orthogonal vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [0, 1, 0])).toBeCloseTo(0.0);
  });

  it('returns -1 for opposite vectors', () => {
    expect(cosineSimilarity([1, 0, 0], [-1, 0, 0])).toBeCloseTo(-1.0);
  });

  it('returns 0 for empty vectors', () => {
    expect(cosineSimilarity([], [])).toBe(0);
  });

  it('returns 0 for zero vectors', () => {
    expect(cosineSimilarity([0, 0, 0], [0, 0, 0])).toBe(0);
  });

  it('returns 0 for mismatched dimensions', () => {
    expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
  });

  it('is symmetric', () => {
    const a = [0.5, 0.3, 0.8];
    const b = [0.2, 0.9, 0.4];
    expect(cosineSimilarity(a, b)).toBeCloseTo(cosineSimilarity(b, a));
  });
});

// =============================================================================
// summarizeChangesSince tests
// =============================================================================

describe('summarizeChangesSince', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns new ADRs created after the given date', async () => {
    const sinceDate = new Date('2024-01-10T00:00:00.000Z');

    mockedQuery
      // First call: query ADRs in room
      .mockResolvedValueOnce({
        ok: true,
        value: [
          { adrId: 'adr-1', title: 'Old ADR', date: '2024-01-05', createdAt: '2024-01-05T00:00:00.000Z' },
          { adrId: 'adr-2', title: 'New ADR', date: '2024-01-15', createdAt: '2024-01-15T00:00:00.000Z' },
        ],
      })
      // Second call: query all threads for superseded (no focusThreadId, so focus loop is skipped)
      .mockResolvedValueOnce({ ok: true, value: [] });

    const result = await summarizeChangesSince({
      roomId: makeRoomId('room-1'),
      sinceDate,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.newADRs).toHaveLength(1);
      expect(result.value.newADRs[0].adrId).toBe('adr-2');
      expect(result.value.totalChanges).toBe(1);
    }
  });

  it('returns superseded threads', async () => {
    const sinceDate = new Date('2024-01-10T00:00:00.000Z');

    mockedQuery
      .mockResolvedValueOnce({ ok: true, value: [] }) // ADRs query
      .mockResolvedValueOnce({
        ok: true,
        value: [
          {
            threadId: 'thread-old',
            title: 'Old thread',
            status: 'SUPERSEDED',
            updatedAt: '2024-01-12T00:00:00.000Z',
            supersededBy: 'thread-new',
          },
          {
            threadId: 'thread-active',
            title: 'Active thread',
            status: 'IN_PROGRESS',
            updatedAt: '2024-01-14T00:00:00.000Z',
          },
        ],
      }); // All threads query (no focusThreadId, so skips focus loop)

    const result = await summarizeChangesSince({
      roomId: makeRoomId('room-1'),
      sinceDate,
      // No focusThreadId — skips the focus thread reference loop
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.supersededThreads).toHaveLength(1);
      expect(result.value.supersededThreads[0].threadId).toBe('thread-old');
      expect(result.value.supersededThreads[0].supersededBy).toBe('thread-new');
    }
  });

  it('returns PERSISTENCE_FAILURE when ADR query fails', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'READ_FAILURE', cause: 'Connection lost' },
    });

    const result = await summarizeChangesSince({
      roomId: makeRoomId('room-1'),
      sinceDate: new Date(),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('PERSISTENCE_FAILURE');
    }
  });

  it('totalChanges equals sum of all arrays', async () => {
    const sinceDate = new Date('2024-01-01T00:00:00.000Z');

    mockedQuery
      .mockResolvedValueOnce({
        ok: true,
        value: [
          { adrId: 'adr-1', title: 'ADR 1', date: '2024-01-05', createdAt: '2024-01-05T00:00:00.000Z' },
        ],
      })
      // No focusThreadId, so only 2 queries: ADRs + all threads for superseded
      .mockResolvedValueOnce({
        ok: true,
        value: [
          { threadId: 't-1', title: 'T1', status: 'SUPERSEDED', updatedAt: '2024-01-05T00:00:00.000Z', supersededBy: 't-2' },
        ],
      });

    const result = await summarizeChangesSince({
      roomId: makeRoomId('room-1'),
      sinceDate,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      const expected = result.value.newADRs.length
        + result.value.threadsReferencingFocus.length
        + result.value.supersededThreads.length;
      expect(result.value.totalChanges).toBe(expected);
    }
  });
});

// =============================================================================
// getReferencesForThread tests
// =============================================================================

describe('getReferencesForThread', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('returns all cross-references for a thread', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: true,
      value: [
        {
          PK: 'THREAD#thread-1',
          SK: 'XREF#thread-2',
          entityType: 'CROSS_REFERENCE',
          sourceThreadId: 'thread-1',
          targetThreadId: 'thread-2',
          referenceType: 'DEPENDS_ON',
          description: 'Depends on auth decision',
          createdAt: '2024-01-10T00:00:00.000Z',
        },
        {
          PK: 'THREAD#thread-1',
          SK: 'XREF#thread-3',
          entityType: 'CROSS_REFERENCE',
          sourceThreadId: 'thread-1',
          targetThreadId: 'thread-3',
          referenceType: 'RELATED_TO',
          description: 'Related caching strategy',
          createdAt: '2024-01-11T00:00:00.000Z',
        },
      ],
    });

    const result = await getReferencesForThread(makeThreadId('thread-1'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(2);
      expect(result.value[0].referenceType).toBe('DEPENDS_ON');
      expect(result.value[1].referenceType).toBe('RELATED_TO');
    }

    expect(mockedQuery).toHaveBeenCalledWith({
      pk: 'THREAD#thread-1',
      skPrefix: 'XREF#',
    });
  });

  it('returns empty array when no references exist', async () => {
    mockedQuery.mockResolvedValueOnce({ ok: true, value: [] });

    const result = await getReferencesForThread(makeThreadId('thread-1'));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toHaveLength(0);
    }
  });

  it('returns PERSISTENCE_FAILURE on read error', async () => {
    mockedQuery.mockResolvedValueOnce({
      ok: false,
      error: { kind: 'READ_FAILURE', cause: 'DynamoDB timeout' },
    });

    const result = await getReferencesForThread(makeThreadId('thread-1'));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('PERSISTENCE_FAILURE');
      expect(result.error.cause).toBe('DynamoDB timeout');
    }
  });
});
