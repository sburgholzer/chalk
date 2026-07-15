import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DynamoError } from '@/services/dynamo';

// Mock the AWS SDK — use vi.hoisted so the mock fn is available during hoisting
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

// Import after mocks are set up
import { putItem, getItem, query, putItemWithRetry } from '@/services/dynamo';

describe('DynamoDB Service', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('putItem', () => {
    it('returns ok with the item on success', async () => {
      mockSend.mockResolvedValueOnce({});
      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1', name: 'Test Room' };

      const result = await putItem({ item });

      expect(result).toEqual({ ok: true, value: item });
    });

    it('returns CONDITION_CHECK_FAILED for conditional failures', async () => {
      const error = new Error('Condition not met');
      error.name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValueOnce(error);

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1', name: 'Test Room' };
      const result = await putItem({
        item,
        conditionExpression: 'attribute_not_exists(PK)',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('CONDITION_CHECK_FAILED');
        expect((result.error as Extract<DynamoError, { kind: 'CONDITION_CHECK_FAILED' }>).message).toBe('Condition not met');
      }
    });

    it('returns WRITE_FAILURE for general errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network timeout'));

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItem({ item });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('WRITE_FAILURE');
        expect((result.error as Extract<DynamoError, { kind: 'WRITE_FAILURE' }>).cause).toBe('Network timeout');
      }
    });

    it('returns WRITE_FAILURE with default message for non-Error throws', async () => {
      mockSend.mockRejectedValueOnce('something weird');

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItem({ item });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('WRITE_FAILURE');
        expect((result.error as Extract<DynamoError, { kind: 'WRITE_FAILURE' }>).cause).toBe('Unknown write error');
      }
    });
  });

  describe('getItem', () => {
    it('returns the item when found', async () => {
      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1', name: 'My Room' };
      mockSend.mockResolvedValueOnce({ Item: item });

      const result = await getItem<typeof item>({ pk: 'TEAM#t1', sk: 'ROOM#r1' });

      expect(result).toEqual({ ok: true, value: item });
    });

    it('returns null when item not found', async () => {
      mockSend.mockResolvedValueOnce({ Item: undefined });

      const result = await getItem({ pk: 'TEAM#t1', sk: 'ROOM#missing' });

      expect(result).toEqual({ ok: true, value: null });
    });

    it('returns READ_FAILURE on error', async () => {
      mockSend.mockRejectedValueOnce(new Error('Table not found'));

      const result = await getItem({ pk: 'TEAM#t1', sk: 'ROOM#r1' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('READ_FAILURE');
        expect((result.error as Extract<DynamoError, { kind: 'READ_FAILURE' }>).cause).toBe('Table not found');
      }
    });
  });

  describe('query', () => {
    it('returns items matching the partition key', async () => {
      const items = [
        { PK: 'ROOM#r1', SK: 'THREAD#t1', title: 'Thread 1' },
        { PK: 'ROOM#r1', SK: 'THREAD#t2', title: 'Thread 2' },
      ];
      mockSend.mockResolvedValueOnce({ Items: items });

      const result = await query<(typeof items)[0]>({ pk: 'ROOM#r1', skPrefix: 'THREAD#' });

      expect(result).toEqual({ ok: true, value: items });
    });

    it('returns empty array when no items match', async () => {
      mockSend.mockResolvedValueOnce({ Items: undefined });

      const result = await query({ pk: 'ROOM#empty' });

      expect(result).toEqual({ ok: true, value: [] });
    });

    it('returns READ_FAILURE on error', async () => {
      mockSend.mockRejectedValueOnce(new Error('Provisioned throughput exceeded'));

      const result = await query({ pk: 'ROOM#r1' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('READ_FAILURE');
      }
    });

    it('passes indexName, limit, and filterExpression to the command', async () => {
      mockSend.mockResolvedValueOnce({ Items: [] });

      await query({
        pk: 'ROOM#r1',
        skPrefix: 'STATUS#',
        indexName: 'GSI1',
        limit: 10,
        filterExpression: 'entityType = :type',
      });

      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('putItemWithRetry', () => {
    it('returns ok on first successful attempt', async () => {
      mockSend.mockResolvedValueOnce({});
      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };

      const result = await putItemWithRetry(item);

      expect(result).toEqual({ ok: true, value: item });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('retries on failure and succeeds on subsequent attempt', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('Transient failure'))
        .mockResolvedValueOnce({});

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItemWithRetry(item, 3, 1); // 1ms base delay for fast tests

      expect(result).toEqual({ ok: true, value: item });
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns RETRIES_EXHAUSTED when all attempts fail', async () => {
      mockSend.mockRejectedValue(new Error('Persistent failure'));

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItemWithRetry(item, 3, 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('RETRIES_EXHAUSTED');
        const retryErr = result.error as Extract<DynamoError, { kind: 'RETRIES_EXHAUSTED' }>;
        expect(retryErr.attempts).toBe(4); // 1 initial + 3 retries
        expect(retryErr.lastError).toBe('Persistent failure');
      }
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it('does not retry on CONDITION_CHECK_FAILED', async () => {
      const error = new Error('Condition not met');
      error.name = 'ConditionalCheckFailedException';
      mockSend.mockRejectedValueOnce(error);

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItemWithRetry(item, 3, 1);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('CONDITION_CHECK_FAILED');
      }
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('uses default maxRetries of 3 and baseDelayMs of 100', async () => {
      mockSend
        .mockRejectedValueOnce(new Error('fail 1'))
        .mockRejectedValueOnce(new Error('fail 2'))
        .mockRejectedValueOnce(new Error('fail 3'))
        .mockRejectedValueOnce(new Error('fail 4'));

      const item = { PK: 'TEAM#t1', SK: 'ROOM#r1' };
      const result = await putItemWithRetry(item);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.kind).toBe('RETRIES_EXHAUSTED');
        const retryErr = result.error as Extract<DynamoError, { kind: 'RETRIES_EXHAUSTED' }>;
        expect(retryErr.attempts).toBe(4);
      }
      expect(mockSend).toHaveBeenCalledTimes(4);
    });
  });
});
