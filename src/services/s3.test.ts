import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isOk, isErr } from '@/types/result';

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(() => ({ send: mockSend })),
  PutObjectCommand: vi.fn((input: unknown) => ({ input })),
  GetObjectCommand: vi.fn((input: unknown) => ({ input })),
}));

describe('S3 Service', () => {
  beforeEach(() => {
    mockSend.mockReset();
  });

  describe('uploadDocument', () => {
    it('returns ok with key and url on successful upload', async () => {
      mockSend.mockResolvedValueOnce({});
      const { uploadDocument } = await import('./s3');

      const result = await uploadDocument({
        key: 'adrs/adr-001.md',
        body: '# ADR-001',
        contentType: 'text/markdown',
      });

      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.key).toBe('adrs/adr-001.md');
        expect(result.value.url).toContain('adrs/adr-001.md');
      }
    });

    it('returns UPLOAD_FAILURE error when S3 throws', async () => {
      mockSend.mockRejectedValueOnce(new Error('Access Denied'));
      const { uploadDocument } = await import('./s3');

      const result = await uploadDocument({
        key: 'test/file.txt',
        body: 'content',
        contentType: 'text/plain',
      });

      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe('UPLOAD_FAILURE');
        expect(result.error).toHaveProperty('cause', 'Access Denied');
      }
    });
  });

  describe('getDocument', () => {
    it('returns ok with body and contentType on successful download', async () => {
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('file content') },
        ContentType: 'text/plain',
      });
      const { getDocument } = await import('./s3');

      const result = await getDocument('docs/file.txt');

      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.body).toBe('file content');
        expect(result.value.contentType).toBe('text/plain');
      }
    });

    it('defaults contentType to application/octet-stream when missing', async () => {
      mockSend.mockResolvedValueOnce({
        Body: { transformToString: () => Promise.resolve('binary data') },
        ContentType: undefined,
      });
      const { getDocument } = await import('./s3');

      const result = await getDocument('data/blob');

      expect(isOk(result)).toBe(true);
      if (result.ok) {
        expect(result.value.contentType).toBe('application/octet-stream');
      }
    });

    it('returns NOT_FOUND when Body is empty', async () => {
      mockSend.mockResolvedValueOnce({
        Body: undefined,
        ContentType: 'text/plain',
      });
      const { getDocument } = await import('./s3');

      const result = await getDocument('missing/file.txt');

      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe('NOT_FOUND');
        expect(result.error).toHaveProperty('key', 'missing/file.txt');
      }
    });

    it('returns NOT_FOUND when S3 throws NoSuchKey', async () => {
      const noSuchKeyError = new Error('The specified key does not exist.');
      (noSuchKeyError as Error & { name: string }).name = 'NoSuchKey';
      mockSend.mockRejectedValueOnce(noSuchKeyError);
      const { getDocument } = await import('./s3');

      const result = await getDocument('nonexistent/key');

      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe('NOT_FOUND');
        expect(result.error).toHaveProperty('key', 'nonexistent/key');
      }
    });

    it('returns DOWNLOAD_FAILURE for other errors', async () => {
      mockSend.mockRejectedValueOnce(new Error('Network timeout'));
      const { getDocument } = await import('./s3');

      const result = await getDocument('some/key');

      expect(isErr(result)).toBe(true);
      if (!result.ok) {
        expect(result.error.kind).toBe('DOWNLOAD_FAILURE');
        expect(result.error).toHaveProperty('cause', 'Network timeout');
      }
    });
  });
});
