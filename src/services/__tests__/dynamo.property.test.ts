import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

/**
 * Property 21: Write retry with exponential backoff
 *
 * Verify that for any failure sequence, the retry mechanism attempts at most
 * 3 retries and delay between attempt N and N+1 is ≥ baseDelay * 2^N ms.
 *
 * **Validates: Requirements 9.4**
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

import { putItemWithRetry } from '@/services/dynamo';

describe('Property 21: Retry with exponential backoff', () => {
  let sleepDelays: number[];
  let originalSetTimeout: typeof globalThis.setTimeout;

  beforeEach(() => {
    mockSend.mockReset();
    sleepDelays = [];
    originalSetTimeout = globalThis.setTimeout;

    // Intercept setTimeout to capture sleep delays but resolve immediately
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('total attempts are bounded by maxRetries + 1 for any failure count', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 10 }), // number of failures before success
        fc.integer({ min: 0, max: 5 }),   // maxRetries config
        fc.integer({ min: 1, max: 500 }), // baseDelayMs
        async (failuresBeforeSuccess, maxRetries, baseDelayMs) => {
          mockSend.mockReset();
          let callCount = 0;

          mockSend.mockImplementation(() => {
            callCount++;
            if (callCount <= failuresBeforeSuccess) {
              return Promise.reject(new Error(`Failure #${callCount}`));
            }
            return Promise.resolve({});
          });

          const item = { PK: 'TEST#1', SK: 'ITEM#1' };
          const resultPromise = putItemWithRetry(item, maxRetries, baseDelayMs);

          // Advance all timers to resolve any sleeps
          await vi.runAllTimersAsync();

          const result = await resultPromise;

          // Core property: total attempts <= maxRetries + 1
          expect(callCount).toBeLessThanOrEqual(maxRetries + 1);

          // If failures < maxRetries + 1, it should succeed
          if (failuresBeforeSuccess <= maxRetries) {
            expect(result.ok).toBe(true);
            expect(callCount).toBe(failuresBeforeSuccess + 1);
          } else {
            // All retries exhausted
            expect(result.ok).toBe(false);
            if (!result.ok) {
              expect(result.error.kind).toBe('RETRIES_EXHAUSTED');
            }
            expect(callCount).toBe(maxRetries + 1);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('delays between retries follow exponential backoff: delay(N) >= baseDelay * 2^N', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 4 }),   // maxRetries (at least 1 to observe delays)
        fc.integer({ min: 10, max: 200 }), // baseDelayMs
        async (maxRetries, baseDelayMs) => {
          mockSend.mockReset();
          const capturedDelays: number[] = [];

          // Spy on setTimeout to capture actual delay values
          const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

          // All attempts fail so we can observe all retry delays
          mockSend.mockRejectedValue(new Error('Persistent failure'));

          const item = { PK: 'TEST#1', SK: 'ITEM#1' };
          const resultPromise = putItemWithRetry(item, maxRetries, baseDelayMs);

          // Advance timers to let all retries complete
          await vi.runAllTimersAsync();

          await resultPromise;

          // Extract delay values from setTimeout calls
          // Filter for our sleep calls (they use setTimeout with a numeric delay)
          for (const call of setTimeoutSpy.mock.calls) {
            const delay = call[1];
            if (typeof delay === 'number' && delay > 0) {
              capturedDelays.push(delay);
            }
          }

          // We expect exactly maxRetries sleep calls (delay happens between retries)
          expect(capturedDelays.length).toBe(maxRetries);

          // Verify exponential backoff: delay for attempt N >= baseDelay * 2^N
          for (let n = 0; n < capturedDelays.length; n++) {
            const expectedMinDelay = baseDelayMs * Math.pow(2, n);
            expect(capturedDelays[n]).toBeGreaterThanOrEqual(expectedMinDelay);
          }

          setTimeoutSpy.mockRestore();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('CONDITION_CHECK_FAILED errors are never retried', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 5 }),    // maxRetries
        fc.integer({ min: 1, max: 500 }),  // baseDelayMs
        async (maxRetries, baseDelayMs) => {
          mockSend.mockReset();

          // Simulate a ConditionalCheckFailedException
          const conditionError = new Error('Condition not met');
          conditionError.name = 'ConditionalCheckFailedException';
          mockSend.mockRejectedValueOnce(conditionError);

          const item = { PK: 'TEST#1', SK: 'ITEM#1' };
          const resultPromise = putItemWithRetry(item, maxRetries, baseDelayMs);

          await vi.runAllTimersAsync();

          const result = await resultPromise;

          // Should NOT retry — only 1 attempt
          expect(mockSend).toHaveBeenCalledTimes(1);

          // Should return the condition check failure directly
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('CONDITION_CHECK_FAILED');
          }
        },
      ),
      { numRuns: 50 },
    );
  });
});
