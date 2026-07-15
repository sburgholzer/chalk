import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateADR, exportADRToS3, getNextSequentialId, formatSequentialId, ADR_GENERATION_TIMEOUT_MS } from './adr-generator';
import type { DecisionThread, CrossReference, RoomId, ThreadId, ADR } from '@/types/domain';

// Mock dependencies
vi.mock('@/services/bedrock', () => ({
  invokeClaudeModel: vi.fn(),
}));

vi.mock('@/services/s3', () => ({
  uploadDocument: vi.fn(),
}));

vi.mock('@/services/dynamo', () => ({
  query: vi.fn(),
}));

import { invokeClaudeModel } from '@/services/bedrock';
import { uploadDocument } from '@/services/s3';
import { query } from '@/services/dynamo';

const mockedInvokeClaude = vi.mocked(invokeClaudeModel);
const mockedUploadDocument = vi.mocked(uploadDocument);
const mockedQuery = vi.mocked(query);

// =============================================================================
// Test Helpers
// =============================================================================

function makeThread(overrides?: Partial<DecisionThread>): DecisionThread {
  return {
    threadId: 'thread-123' as ThreadId,
    roomId: 'room-456' as RoomId,
    title: 'Choose a message broker',
    status: 'DECIDED',
    createdBy: 'user-1',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-15T00:00:00.000Z',
    selectedOption: 'Apache Kafka',
    ...overrides,
  };
}

function makeValidADRResponse(): string {
  return JSON.stringify({
    title: 'Use Apache Kafka for Event Streaming',
    context: 'The team needs a message broker that can handle high throughput event streaming with guaranteed ordering.',
    optionsConsidered: [
      { name: 'Apache Kafka', summary: 'Distributed event streaming platform with high throughput' },
      { name: 'Amazon SQS', summary: 'Managed message queue with at-least-once delivery' },
    ],
    decision: 'We chose Apache Kafka because it provides ordered event streaming with high throughput.',
    consequences: 'The team will need to manage Kafka clusters and handle partition rebalancing.',
  });
}

function makeCrossReferences(): CrossReference[] {
  return [
    {
      sourceThreadId: 'thread-123' as ThreadId,
      targetThreadId: 'thread-100' as ThreadId,
      referenceType: 'DEPENDS_ON',
      description: 'Event schema design decision',
      createdAt: '2024-01-10T00:00:00.000Z',
    },
  ];
}

// =============================================================================
// Tests
// =============================================================================

describe('adr-generator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  describe('formatSequentialId', () => {
    it('pads single digit to three characters', () => {
      expect(formatSequentialId(1)).toBe('001');
    });

    it('pads double digit to three characters', () => {
      expect(formatSequentialId(42)).toBe('042');
    });

    it('keeps triple digit as-is', () => {
      expect(formatSequentialId(100)).toBe('100');
    });

    it('handles numbers over 999', () => {
      expect(formatSequentialId(1234)).toBe('1234');
    });
  });

  describe('getNextSequentialId', () => {
    it('returns 1 when no existing ADRs', async () => {
      mockedQuery.mockResolvedValue({ ok: true, value: [] });

      const result = await getNextSequentialId('room-456' as RoomId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(1);
      }
      expect(mockedQuery).toHaveBeenCalledWith({
        pk: 'ROOM#room-456',
        skPrefix: 'ADR_SEQ#',
        indexName: 'GSI3',
        limit: 1,
      });
    });

    it('returns next ID after existing ADRs', async () => {
      mockedQuery.mockResolvedValue({ ok: true, value: [{ sequentialId: 5 }] });

      const result = await getNextSequentialId('room-456' as RoomId);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(6);
      }
    });

    it('returns error on query failure', async () => {
      mockedQuery.mockResolvedValue({ ok: false, error: { kind: 'READ_FAILURE', cause: 'timeout' } });

      const result = await getNextSequentialId('room-456' as RoomId);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('GENERATION_FAILURE');
      }
    });
  });

  describe('generateADR', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('generates a valid ADR from a decided thread', async () => {
      mockedInvokeClaude.mockResolvedValue({ ok: true, value: makeValidADRResponse() });

      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 3,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.adrId).toBe('ADR-003');
        expect(result.value.title).toBe('Use Apache Kafka for Event Streaming');
        expect(result.value.status).toBe('ACTIVE');
        expect(result.value.sequentialId).toBe(3);
        expect(result.value.optionsConsidered).toHaveLength(2);
        expect(result.value.context).toContain('message broker');
        expect(result.value.decision).toContain('Kafka');
        expect(result.value.consequences).toContain('partition');
        expect(result.value.roomId).toBe('room-456');
        expect(result.value.threadId).toBe('thread-123');
      }
    });

    it('includes cross-references in related decisions', async () => {
      mockedInvokeClaude.mockResolvedValue({ ok: true, value: makeValidADRResponse() });

      const crossRefs = makeCrossReferences();
      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: crossRefs,
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.relatedDecisions).toHaveLength(1);
        expect(result.value.relatedDecisions[0].adrId).toBe('thread-100');
        expect(result.value.relatedDecisions[0].relationship).toBe('DEPENDS_ON');
      }
    });

    it('returns INSUFFICIENT_CONTEXT for empty title', async () => {
      const result = await generateADR({
        thread: makeThread({ title: '' }),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INSUFFICIENT_CONTEXT');
        if (result.error.kind === 'INSUFFICIENT_CONTEXT') {
          expect(result.error.missingSections).toContain('title');
        }
      }
    });

    it('returns INSUFFICIENT_CONTEXT for empty selectedOption', async () => {
      const result = await generateADR({
        thread: makeThread(),
        selectedOption: '',
        crossReferences: [],
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('INSUFFICIENT_CONTEXT');
        if (result.error.kind === 'INSUFFICIENT_CONTEXT') {
          expect(result.error.missingSections).toContain('decision');
        }
      }
    });

    it('returns GENERATION_FAILURE when Bedrock fails all attempts', async () => {
      mockedInvokeClaude.mockResolvedValue({
        ok: false,
        error: { kind: 'INVOCATION_FAILURE', statusCode: 500, message: 'Internal error' },
      });

      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('GENERATION_FAILURE');
        if (result.error.kind === 'GENERATION_FAILURE') {
          expect(result.error.attempt).toBe(3);
        }
      }
      // Called 3 times (retry up to 3 attempts)
      expect(mockedInvokeClaude).toHaveBeenCalledTimes(3);
    });

    it('returns GENERATION_FAILURE when response is invalid JSON', async () => {
      mockedInvokeClaude.mockResolvedValue({ ok: true, value: 'not json at all' });

      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('GENERATION_FAILURE');
        if (result.error.kind === 'GENERATION_FAILURE') {
          expect(result.error.cause).toContain('Response validation failed');
        }
      }
    });

    it('retries on failure and succeeds on second attempt', async () => {
      mockedInvokeClaude
        .mockResolvedValueOnce({
          ok: false,
          error: { kind: 'INVOCATION_FAILURE', statusCode: 500, message: 'transient' },
        })
        .mockResolvedValueOnce({ ok: true, value: makeValidADRResponse() });

      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 2,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.adrId).toBe('ADR-002');
      }
      expect(mockedInvokeClaude).toHaveBeenCalledTimes(2);
    });

    it('formats sequential ID as ADR-001', async () => {
      mockedInvokeClaude.mockResolvedValue({ ok: true, value: makeValidADRResponse() });

      const result = await generateADR({
        thread: makeThread(),
        selectedOption: 'Apache Kafka',
        crossReferences: [],
        nextSequentialId: 1,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.adrId).toBe('ADR-001');
      }
    });
  });

  describe('exportADRToS3', () => {
    beforeEach(() => {
      vi.useRealTimers();
    });

    it('uploads ADR document to S3 with correct key', async () => {
      mockedUploadDocument.mockResolvedValue({
        ok: true,
        value: { key: 'adrs/room-456/ADR-001.json', url: 'https://bucket.s3.amazonaws.com/adrs/room-456/ADR-001.json' },
      });

      const adr: ADR = {
        adrId: 'ADR-001',
        roomId: 'room-456' as RoomId,
        threadId: 'thread-123' as ThreadId,
        sequentialId: 1,
        title: 'Use Kafka',
        status: 'ACTIVE',
        date: '2024-01-15T00:00:00.000Z',
        context: 'Need a message broker',
        optionsConsidered: [
          { name: 'Kafka', summary: 'Distributed streaming' },
          { name: 'SQS', summary: 'Managed queue' },
        ],
        decision: 'Use Kafka for streaming',
        consequences: 'Must manage clusters',
        relatedDecisions: [],
        createdAt: '2024-01-15T00:00:00.000Z',
        updatedAt: '2024-01-15T00:00:00.000Z',
      };

      const result = await exportADRToS3(adr);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.s3Key).toBe('adrs/room-456/ADR-001.json');
      }
      expect(mockedUploadDocument).toHaveBeenCalledWith({
        key: 'adrs/room-456/ADR-001.json',
        body: expect.stringContaining('"identifier": "ADR-001"'),
        contentType: 'application/json',
      });
    });

    it('returns S3_UPLOAD_FAILURE on upload error', async () => {
      mockedUploadDocument.mockResolvedValue({
        ok: false,
        error: { kind: 'UPLOAD_FAILURE', cause: 'Network error' },
      });

      const adr: ADR = {
        adrId: 'ADR-001',
        roomId: 'room-456' as RoomId,
        threadId: 'thread-123' as ThreadId,
        sequentialId: 1,
        title: 'Use Kafka',
        status: 'ACTIVE',
        date: '2024-01-15T00:00:00.000Z',
        context: 'Need a message broker',
        optionsConsidered: [
          { name: 'Kafka', summary: 'Distributed streaming' },
          { name: 'SQS', summary: 'Managed queue' },
        ],
        decision: 'Use Kafka for streaming',
        consequences: 'Must manage clusters',
        relatedDecisions: [],
        createdAt: '2024-01-15T00:00:00.000Z',
        updatedAt: '2024-01-15T00:00:00.000Z',
      };

      const result = await exportADRToS3(adr);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('S3_UPLOAD_FAILURE');
        if (result.error.kind === 'S3_UPLOAD_FAILURE') {
          expect(result.error.cause).toBe('Network error');
        }
      }
    });
  });

  describe('ADR_GENERATION_TIMEOUT_MS', () => {
    it('is set to 30 seconds', () => {
      expect(ADR_GENERATION_TIMEOUT_MS).toBe(30_000);
    });
  });
});
