import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { isOk, isErr } from '@/types/result';

// Mock the AWS SDK before importing the module under test
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-bedrock-runtime', () => {
  return {
    BedrockRuntimeClient: vi.fn().mockImplementation(() => ({
      send: mockSend,
    })),
    InvokeModelCommand: vi.fn().mockImplementation((input) => input),
    ThrottlingException: class ThrottlingException extends Error {
      name = 'ThrottlingException';
      constructor(opts: { message: string }) {
        super(opts.message);
      }
    },
    ValidationException: class ValidationException extends Error {
      name = 'ValidationException';
      constructor(opts: { message: string }) {
        super(opts.message);
      }
    },
  };
});

import { invokeClaudeModel, generateTitanEmbedding } from './bedrock';
import { ThrottlingException, ValidationException } from '@aws-sdk/client-bedrock-runtime';

describe('Bedrock Service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('invokeClaudeModel', () => {
    it('returns ok with extracted text on successful invocation', async () => {
      const responseBody = {
        content: [{ type: 'text', text: 'Hello from Claude' }],
      };
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify(responseBody)),
      });

      const result = await invokeClaudeModel({
        systemPrompt: 'You are a helpful assistant.',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe('Hello from Claude');
      }
    });

    it('returns VALIDATION_ERROR for ValidationException without retrying', async () => {
      mockSend.mockRejectedValueOnce(
        new ValidationException({ message: 'Invalid input' } as any)
      );

      const result = await invokeClaudeModel({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('VALIDATION_ERROR');
        if (result.error.kind === 'VALIDATION_ERROR') {
          expect(result.error.message).toBe('Invalid input');
        }
      }
      // Should not retry on validation errors
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('retries on ThrottlingException and succeeds', async () => {
      const responseBody = {
        content: [{ type: 'text', text: 'Success after retry' }],
      };
      mockSend
        .mockRejectedValueOnce(
          new ThrottlingException({ message: 'Too many requests' } as any)
        )
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(JSON.stringify(responseBody)),
        });

      const promise = invokeClaudeModel({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });

      // Advance timers for the backoff delay
      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);

      const result = await promise;

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toBe('Success after retry');
      }
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('returns THROTTLED after exhausting all retries on throttling', async () => {
      mockSend.mockRejectedValue(
        new ThrottlingException({ message: 'Too many requests' } as any)
      );

      const promise = invokeClaudeModel({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });

      // Advance timers past all retry delays
      await vi.advanceTimersByTimeAsync(10000);

      const result = await promise;

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('THROTTLED');
      }
      // 1 initial + 3 retries = 4 total attempts
      expect(mockSend).toHaveBeenCalledTimes(4);
    });

    it('returns INVOCATION_FAILURE for non-transient errors without retrying', async () => {
      const error = new Error('Access denied');
      (error as any).$metadata = { httpStatusCode: 403 };
      mockSend.mockRejectedValueOnce(error);

      const result = await invokeClaudeModel({
        systemPrompt: 'test',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('INVOCATION_FAILURE');
        if (result.error.kind === 'INVOCATION_FAILURE') {
          expect(result.error.statusCode).toBe(403);
          expect(result.error.message).toBe('Access denied');
        }
      }
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });

  describe('generateTitanEmbedding', () => {
    it('returns ok with embedding array on success', async () => {
      const embedding = Array.from({ length: 1536 }, (_, i) => i * 0.001);
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ embedding })),
      });

      const result = await generateTitanEmbedding('some text to embed');

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toHaveLength(1536);
        expect(result.value[0]).toBe(0);
        expect(result.value[1]).toBeCloseTo(0.001);
      }
    });

    it('returns INVOCATION_FAILURE when response has no embedding', async () => {
      mockSend.mockResolvedValueOnce({
        body: new TextEncoder().encode(JSON.stringify({ data: 'unexpected' })),
      });

      const result = await generateTitanEmbedding('test');

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('INVOCATION_FAILURE');
        if (result.error.kind === 'INVOCATION_FAILURE') {
          expect(result.error.message).toContain('embedding array');
        }
      }
    });

    it('returns VALIDATION_ERROR for ValidationException without retrying', async () => {
      mockSend.mockRejectedValueOnce(
        new ValidationException({ message: 'Text too long' } as any)
      );

      const result = await generateTitanEmbedding('very long text...');

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('VALIDATION_ERROR');
      }
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('retries on ThrottlingException and succeeds', async () => {
      const embedding = [0.1, 0.2, 0.3];
      mockSend
        .mockRejectedValueOnce(
          new ThrottlingException({ message: 'Rate limited' } as any)
        )
        .mockResolvedValueOnce({
          body: new TextEncoder().encode(JSON.stringify({ embedding })),
        });

      const promise = generateTitanEmbedding('text');

      await vi.advanceTimersByTimeAsync(BASE_DELAY_MS);

      const result = await promise;

      expect(isOk(result)).toBe(true);
      if (isOk(result)) {
        expect(result.value).toEqual([0.1, 0.2, 0.3]);
      }
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries and returns error', async () => {
      mockSend.mockRejectedValue(
        new ThrottlingException({ message: 'Rate limited' } as any)
      );

      const promise = generateTitanEmbedding('text');

      await vi.advanceTimersByTimeAsync(10000);

      const result = await promise;

      expect(isErr(result)).toBe(true);
      if (isErr(result)) {
        expect(result.error.kind).toBe('THROTTLED');
      }
      // 1 initial + 3 retries = 4 total
      expect(mockSend).toHaveBeenCalledTimes(4);
    });
  });
});

// Constant used in tests
const BASE_DELAY_MS = 200;
