import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fc from 'fast-check';

// =============================================================================
// Shared Mocks
// =============================================================================

const mockGenerateTitanEmbedding = vi.hoisted(() => vi.fn());
const mockQuery = vi.hoisted(() => vi.fn());
const mockPutItem = vi.hoisted(() => vi.fn());

vi.mock('@/services/bedrock', () => ({
  generateTitanEmbedding: mockGenerateTitanEmbedding,
}));

vi.mock('@/services/dynamo', () => ({
  query: mockQuery,
  putItem: mockPutItem,
}));

import { semanticSearch, cosineSimilarity } from '@/lib/decision-journal';
import type { EmbeddingItem } from '@/types/domain';

// =============================================================================
// Generators
// =============================================================================

/** Generates empty strings (zero length). */
const emptyStringArb = fc.constant('');

/** Generates whitespace-only strings using spaces, tabs, newlines, carriage returns. */
const whitespaceOnlyArb = fc.stringOf(
  fc.constantFrom(' ', '\t', '\n', '\r', '\f', '\v'),
  { minLength: 1, maxLength: 50 },
);

/** Combines empty and whitespace-only string generators. */
const emptyOrWhitespaceArb = fc.oneof(emptyStringArb, whitespaceOnlyArb);

/** Generates a non-empty roomId string. */
const roomIdArb = fc.uuid();

// =============================================================================
// Property 15: Empty/whitespace search query rejection
// =============================================================================

/**
 * Property 15: Empty/whitespace search query rejection
 *
 * For any empty or whitespace-only string, `semanticSearch` returns error with
 * `EMPTY_QUERY` kind without executing embedding generation.
 *
 * **Validates: Requirements 7.6**
 */

describe('Property 15: Empty/whitespace search query rejection', () => {
  beforeEach(() => {
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  it('for any empty or whitespace-only string, semanticSearch returns err with EMPTY_QUERY kind', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        emptyOrWhitespaceArb,
        async (roomId, emptyQuery) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const result = await semanticSearch({
            roomId,
            query: emptyQuery,
          });

          // Must return an error result
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Error kind must be EMPTY_QUERY
            expect(result.error.kind).toBe('EMPTY_QUERY');
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any empty or whitespace-only string, generateTitanEmbedding is never called', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        emptyOrWhitespaceArb,
        async (roomId, emptyQuery) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          await semanticSearch({
            roomId,
            query: emptyQuery,
          });

          // Embedding generation must NOT be invoked for invalid queries
          expect(mockGenerateTitanEmbedding).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any empty or whitespace-only string with optional filters, semanticSearch still rejects with EMPTY_QUERY', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        emptyOrWhitespaceArb,
        fc.record({
          status: fc.constantFrom('DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED') as fc.Arbitrary<'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED'>,
          title: fc.string({ minLength: 1, maxLength: 50 }),
        }),
        async (roomId, emptyQuery, filters) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const result = await semanticSearch({
            roomId,
            query: emptyQuery,
            filters: { status: filters.status, title: filters.title },
          });

          // Must return an error result with EMPTY_QUERY
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('EMPTY_QUERY');
          }

          // Embedding generation must NOT be invoked
          expect(mockGenerateTitanEmbedding).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 16: Cosine similarity is symmetric and bounded
// =============================================================================

/**
 * Property 16: Cosine similarity is symmetric and bounded
 *
 * For any two equal-dimension vectors, `cosineSimilarity(a, b)` equals
 * `cosineSimilarity(b, a)` and result is in [-1, 1].
 *
 * **Validates: Requirements 7.1**
 */
describe('Property 16: Cosine similarity is symmetric and bounded', () => {
  // Generate finite floats only (no NaN, no Infinity)
  const finiteFloat = fc.double({ min: -1e6, max: 1e6, noNaN: true });

  const vectorPair = fc
    .integer({ min: 3, max: 50 })
    .chain((len) =>
      fc.tuple(
        fc.array(finiteFloat, { minLength: len, maxLength: len }),
        fc.array(finiteFloat, { minLength: len, maxLength: len }),
      ),
    );

  it('cosineSimilarity(a, b) ≈ cosineSimilarity(b, a) for any two equal-dimension vectors', () => {
    fc.assert(
      fc.property(vectorPair, ([a, b]) => {
        const ab = cosineSimilarity(a, b);
        const ba = cosineSimilarity(b, a);

        // Symmetric within floating-point tolerance
        expect(ab).toBeCloseTo(ba, 10);
      }),
      { numRuns: 200 },
    );
  });

  it('result is always in range [-1, 1]', () => {
    fc.assert(
      fc.property(vectorPair, ([a, b]) => {
        const result = cosineSimilarity(a, b);

        expect(result).toBeGreaterThanOrEqual(-1);
        expect(result).toBeLessThanOrEqual(1);
      }),
      { numRuns: 200 },
    );
  });

  it('cosineSimilarity(a, a) ≈ 1 for any non-zero vector', () => {
    // Generate vectors with at least one component of meaningful magnitude
    // to avoid floating-point underflow with subnormal numbers
    const nonZeroVector = fc
      .integer({ min: 3, max: 50 })
      .chain((len) =>
        fc.array(finiteFloat, { minLength: len, maxLength: len }),
      )
      .filter((v) => v.some((x) => Math.abs(x) > 1e-10));

    fc.assert(
      fc.property(nonZeroVector, (a) => {
        const result = cosineSimilarity(a, a);

        // Self-similarity should be 1 (within floating-point tolerance)
        expect(result).toBeCloseTo(1, 5);
      }),
      { numRuns: 200 },
    );
  });

  it('cosineSimilarity(a, zero) = 0 for any vector paired with a zero vector', () => {
    const vectorWithLength = fc
      .integer({ min: 3, max: 50 })
      .chain((len) =>
        fc.tuple(
          fc.array(finiteFloat, { minLength: len, maxLength: len }),
          fc.constant(len),
        ),
      );

    fc.assert(
      fc.property(vectorWithLength, ([a, len]) => {
        const zeroVector = new Array(len).fill(0);
        const result = cosineSimilarity(a, zeroVector);

        expect(result).toBe(0);
      }),
      { numRuns: 200 },
    );
  });
});


// =============================================================================
// Property 12: Semantic search results are ranked by similarity and bounded
// =============================================================================

/**
 * Property 12: Semantic search results are ranked by similarity and bounded
 *
 * For any set of embeddings and query, results are in descending similarity order,
 * contain at most 50 results, all with scores ≥ 0.7.
 *
 * **Validates: Requirements 7.1, 7.5**
 */

// Generators specific to Property 12

/** Fixed embedding dimension (small for fast testing, consistent with cosine math). */
const EMBEDDING_DIM = 16;

/** Generates a non-zero embedding vector of fixed dimension. */
const embeddingVectorArb = fc
  .array(fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }), {
    minLength: EMBEDDING_DIM,
    maxLength: EMBEDDING_DIM,
  })
  .filter((v) => v.some((x) => x !== 0)); // Ensure non-zero vector

/** Generates a random EmbeddingItem with a given embedding vector. */
function embeddingItemArb(roomId: string): fc.Arbitrary<EmbeddingItem> {
  return fc.record({
    embedding: embeddingVectorArb,
    entityId: fc.uuid(),
    entityTypeRef: fc.constantFrom('THREAD', 'ADR') as fc.Arbitrary<'THREAD' | 'ADR'>,
    textSummary: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
    createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()),
    updatedAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()),
  }).map((item) => ({
    PK: `ROOM#${roomId}` as `ROOM#${string}`,
    SK: `EMB#${item.entityTypeRef}#${item.entityId}` as `EMB#${string}#${string}`,
    entityType: 'EMBEDDING' as const,
    roomId,
    entityId: item.entityId,
    entityTypeRef: item.entityTypeRef,
    embedding: item.embedding,
    textSummary: item.textSummary,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  }));
}

describe('Property 12: Semantic search results are ranked by similarity and bounded', () => {
  beforeEach(() => {
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  it('for any set of embeddings and query, results are in descending similarity order', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), // query text
        embeddingVectorArb, // query embedding
        fc.array(embeddingVectorArb, { minLength: 5, maxLength: 60 }), // stored embeddings
        async (roomId, queryText, queryEmbedding, storedEmbeddings) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to return the fixed query embedding
          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          // Build EmbeddingItem records from the stored embeddings
          const embeddingItems: EmbeddingItem[] = storedEmbeddings.map((emb, idx) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#entity-${idx}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: `entity-${idx}`,
            entityTypeRef: 'THREAD' as const,
            embedding: emb,
            textSummary: `Summary for entity ${idx}`,
            createdAt: new Date('2024-01-01').toISOString(),
            updatedAt: new Date('2024-01-01').toISOString(),
          }));

          // First query call returns embeddings, second returns thread metadata
          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({
              ok: true,
              value: embeddingItems.map((item) => ({
                PK: `ROOM#${roomId}`,
                SK: `THREAD#${item.entityId}`,
                threadId: item.entityId,
                title: `Thread ${item.entityId}`,
                status: 'IN_PROGRESS' as const,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })),
            });

          const result = await semanticSearch({
            roomId,
            query: queryText,
          });

          // Must succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const results = result.value;

          // Verify descending order by similarityScore
          for (let i = 1; i < results.length; i++) {
            expect(results[i - 1].similarityScore).toBeGreaterThanOrEqual(
              results[i].similarityScore,
            );
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any set of embeddings and query, results contain at most 50 items', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), // query text
        embeddingVectorArb, // query embedding
        fc.array(embeddingVectorArb, { minLength: 5, maxLength: 60 }), // stored embeddings
        async (roomId, queryText, queryEmbedding, storedEmbeddings) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to return the fixed query embedding
          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          // Build EmbeddingItem records from the stored embeddings
          const embeddingItems: EmbeddingItem[] = storedEmbeddings.map((emb, idx) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#entity-${idx}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: `entity-${idx}`,
            entityTypeRef: 'THREAD' as const,
            embedding: emb,
            textSummary: `Summary for entity ${idx}`,
            createdAt: new Date('2024-01-01').toISOString(),
            updatedAt: new Date('2024-01-01').toISOString(),
          }));

          // First query call returns embeddings, second returns thread metadata
          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({
              ok: true,
              value: embeddingItems.map((item) => ({
                PK: `ROOM#${roomId}`,
                SK: `THREAD#${item.entityId}`,
                threadId: item.entityId,
                title: `Thread ${item.entityId}`,
                status: 'IN_PROGRESS' as const,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })),
            });

          const result = await semanticSearch({
            roomId,
            query: queryText,
          });

          // Must succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Results are bounded to at most 50
          expect(result.value.length).toBeLessThanOrEqual(50);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any set of embeddings and query, all results have similarityScore >= 0.7', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), // query text
        embeddingVectorArb, // query embedding
        fc.array(embeddingVectorArb, { minLength: 5, maxLength: 60 }), // stored embeddings
        async (roomId, queryText, queryEmbedding, storedEmbeddings) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to return the fixed query embedding
          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          // Build EmbeddingItem records from the stored embeddings
          const embeddingItems: EmbeddingItem[] = storedEmbeddings.map((emb, idx) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#entity-${idx}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: `entity-${idx}`,
            entityTypeRef: 'THREAD' as const,
            embedding: emb,
            textSummary: `Summary for entity ${idx}`,
            createdAt: new Date('2024-01-01').toISOString(),
            updatedAt: new Date('2024-01-01').toISOString(),
          }));

          // First query call returns embeddings, second returns thread metadata
          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({
              ok: true,
              value: embeddingItems.map((item) => ({
                PK: `ROOM#${roomId}`,
                SK: `THREAD#${item.entityId}`,
                threadId: item.entityId,
                title: `Thread ${item.entityId}`,
                status: 'IN_PROGRESS' as const,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
              })),
            });

          const result = await semanticSearch({
            roomId,
            query: queryText,
          });

          // Must succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // All results must have similarity >= 0.7
          for (const searchResult of result.value) {
            expect(searchResult.similarityScore).toBeGreaterThanOrEqual(0.7);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 27: Embedding indexing on entity write
// =============================================================================

/**
 * Property 27: Embedding indexing on entity write
 *
 * For any thread/ADR created or updated, `indexEntity` generates a 1536-dim embedding,
 * persists it with correct keys, and it is retrievable by `semanticSearch` immediately after.
 *
 * **Validates: Requirements 7.4**
 */

import { indexEntity } from '@/lib/decision-journal';

describe('Property 27: Embedding indexing on entity write', () => {
  beforeEach(() => {
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  /** Generates a non-empty alphanumeric string suitable for IDs. */
  const entityIdArb = fc.uuid();

  /** Generates a non-empty room ID. */
  const roomIdArbP27 = fc.uuid();

  /** Generates entity type. */
  const entityTypeArb = fc.constantFrom('THREAD', 'ADR') as fc.Arbitrary<'THREAD' | 'ADR'>;

  /** Generates non-empty content string. */
  const contentArb = fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0);

  /** Generates summary strings of varying length (including those exceeding 200 chars). */
  const summaryArb = fc.string({ minLength: 1, maxLength: 400 }).filter((s) => s.trim().length > 0);

  /** Generates a 1536-dimension embedding vector. */
  const titanEmbeddingArb = fc.array(
    fc.double({ min: -1, max: 1, noNaN: true, noDefaultInfinity: true }),
    { minLength: 1536, maxLength: 1536 },
  );

  it('indexEntity returns ok with an embedding array for any valid inputs', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArbP27,
        entityIdArb,
        entityTypeArb,
        contentArb,
        summaryArb,
        titanEmbeddingArb,
        async (roomId, entityId, entityType, content, summary, embedding) => {
          mockGenerateTitanEmbedding.mockReset();
          mockPutItem.mockReset();

          // Mock generateTitanEmbedding to return a 1536-dim vector
          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: embedding,
          });

          // Mock putItem to succeed
          mockPutItem.mockResolvedValueOnce({ ok: true, value: undefined });

          const result = await indexEntity({
            roomId,
            entityId,
            entityType,
            content,
            summary,
          });

          // Result must be ok and contain an embedding array
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(Array.isArray(result.value.embedding)).toBe(true);
          expect(result.value.embedding.length).toBe(1536);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('putItem is called with PK=ROOM#{roomId} and SK=EMB#{entityType}#{entityId}', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArbP27,
        entityIdArb,
        entityTypeArb,
        contentArb,
        summaryArb,
        titanEmbeddingArb,
        async (roomId, entityId, entityType, content, summary, embedding) => {
          mockGenerateTitanEmbedding.mockReset();
          mockPutItem.mockReset();

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: embedding,
          });

          mockPutItem.mockResolvedValueOnce({ ok: true, value: undefined });

          await indexEntity({
            roomId,
            entityId,
            entityType,
            content,
            summary,
          });

          // putItem must have been called exactly once
          expect(mockPutItem).toHaveBeenCalledTimes(1);

          // Verify the item keys
          const callArgs = mockPutItem.mock.calls[0][0];
          const item = callArgs.item;

          expect(item.PK).toBe(`ROOM#${roomId}`);
          expect(item.SK).toBe(`EMB#${entityType}#${entityId}`);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the stored summary is truncated to ≤200 characters', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArbP27,
        entityIdArb,
        entityTypeArb,
        contentArb,
        summaryArb,
        titanEmbeddingArb,
        async (roomId, entityId, entityType, content, summary, embedding) => {
          mockGenerateTitanEmbedding.mockReset();
          mockPutItem.mockReset();

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: embedding,
          });

          mockPutItem.mockResolvedValueOnce({ ok: true, value: undefined });

          await indexEntity({
            roomId,
            entityId,
            entityType,
            content,
            summary,
          });

          // Verify summary truncation in the stored item
          expect(mockPutItem).toHaveBeenCalledTimes(1);
          const callArgs = mockPutItem.mock.calls[0][0];
          const item = callArgs.item;

          expect(item.textSummary.length).toBeLessThanOrEqual(200);

          // If original summary was ≤200, it should be stored as-is
          if (summary.length <= 200) {
            expect(item.textSummary).toBe(summary);
          } else {
            // If longer, it should be the first 200 chars
            expect(item.textSummary).toBe(summary.slice(0, 200));
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('the embedding has the correct dimensions matching what Titan returned', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArbP27,
        entityIdArb,
        entityTypeArb,
        contentArb,
        summaryArb,
        titanEmbeddingArb,
        async (roomId, entityId, entityType, content, summary, embedding) => {
          mockGenerateTitanEmbedding.mockReset();
          mockPutItem.mockReset();

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: embedding,
          });

          mockPutItem.mockResolvedValueOnce({ ok: true, value: undefined });

          const result = await indexEntity({
            roomId,
            entityId,
            entityType,
            content,
            summary,
          });

          // The returned embedding should match what Titan returned
          expect(result.ok).toBe(true);
          if (!result.ok) return;
          expect(result.value.embedding).toEqual(embedding);
          expect(result.value.embedding.length).toBe(1536);

          // The persisted item should also have the same embedding
          const callArgs = mockPutItem.mock.calls[0][0];
          const item = callArgs.item;
          expect(item.embedding).toEqual(embedding);
          expect(item.embedding.length).toBe(1536);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 14: Search result structure completeness
// =============================================================================

/**
 * Property 14: Search result structure completeness
 *
 * For any search result, it includes: non-empty title, valid ThreadStatus,
 * valid date, numeric similarity score between 0 and 1, and text summary
 * ≤200 characters.
 *
 * **Validates: Requirements 7.3**
 */

describe('Property 14: Search result structure completeness', () => {
  beforeEach(() => {
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  /** Valid ThreadStatus values. */
  const VALID_STATUSES: readonly string[] = ['DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];

  /** Generates thread metadata with arbitrary valid titles, statuses, and dates. */
  const threadMetadataArb = fc.record({
    title: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    status: fc.constantFrom('DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED') as fc.Arbitrary<'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED'>,
    createdAt: fc.date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') }).map((d) => d.toISOString()),
  });

  /** Generates a summary string that is ≤200 characters. */
  const summaryArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

  it('every search result has non-empty title, valid ThreadStatus, valid date, similarity in [0,1], and summary ≤200 chars', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), // query
        embeddingVectorArb, // query embedding
        fc.array(
          fc.tuple(embeddingVectorArb, threadMetadataArb, summaryArb),
          { minLength: 1, maxLength: 20 },
        ), // stored items: embedding + thread metadata + summary
        async (roomId, queryText, queryEmbedding, storedItems) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Use a query embedding that is very close to stored embeddings to guarantee results
          // We mock the query embedding to be one of the stored embeddings to ensure high similarity
          const highSimilarityEmbedding = storedItems[0][0];

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: highSimilarityEmbedding,
          });

          // Build EmbeddingItems from stored items
          const embeddingItems: EmbeddingItem[] = storedItems.map(([emb, _meta, summary], idx) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#entity-${idx}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: `entity-${idx}`,
            entityTypeRef: 'THREAD' as const,
            embedding: emb,
            textSummary: summary.slice(0, 200), // ensure ≤200 chars in mock data
            createdAt: new Date('2024-01-15').toISOString(),
            updatedAt: new Date('2024-01-15').toISOString(),
          }));

          // Build thread metadata items
          const threadItems = storedItems.map(([_emb, meta], idx) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#entity-${idx}`,
            threadId: `entity-${idx}`,
            title: meta.title,
            status: meta.status,
            createdAt: meta.createdAt,
            updatedAt: meta.createdAt,
          }));

          // First query → embeddings, second query → thread metadata
          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            minSimilarity: 0.0, // Lower threshold to ensure we get results for structural validation
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const results = result.value;

          // Skip if no results passed the similarity threshold
          // (though with minSimilarity: 0.0, we should get results unless cosine is negative)
          for (const searchResult of results) {
            // 1. Title is non-empty
            expect(searchResult.title.length).toBeGreaterThan(0);

            // 2. Status is a valid ThreadStatus
            expect(VALID_STATUSES).toContain(searchResult.status);

            // 3. Date is a valid ISO 8601 string
            const parsedDate = new Date(searchResult.date);
            expect(parsedDate.toString()).not.toBe('Invalid Date');
            // Verify it round-trips to a valid ISO string
            expect(typeof searchResult.date).toBe('string');
            expect(searchResult.date.length).toBeGreaterThan(0);

            // 4. Similarity score is a number between 0 and 1
            expect(typeof searchResult.similarityScore).toBe('number');
            expect(searchResult.similarityScore).toBeGreaterThanOrEqual(0);
            expect(searchResult.similarityScore).toBeLessThanOrEqual(1);

            // 5. Summary is ≤200 characters
            expect(searchResult.summary.length).toBeLessThanOrEqual(200);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('search results with thread metadata always reflect provided metadata fields', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0), // query
        threadMetadataArb,
        summaryArb,
        async (roomId, queryText, meta, summary) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Create a single embedding item with a known vector
          const embedding = Array.from({ length: EMBEDDING_DIM }, () => 0.5);

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: embedding, // Same vector → cosine similarity = 1.0
          });

          const embeddingItems: EmbeddingItem[] = [{
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#test-entity` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: 'test-entity',
            entityTypeRef: 'THREAD' as const,
            embedding,
            textSummary: summary.slice(0, 200),
            createdAt: new Date('2024-01-15').toISOString(),
            updatedAt: new Date('2024-01-15').toISOString(),
          }];

          const threadItems = [{
            PK: `ROOM#${roomId}`,
            SK: `THREAD#test-entity`,
            threadId: 'test-entity',
            title: meta.title,
            status: meta.status,
            createdAt: meta.createdAt,
            updatedAt: meta.createdAt,
          }];

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            minSimilarity: 0.0,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Should have exactly 1 result with perfect similarity
          expect(result.value.length).toBe(1);
          const searchResult = result.value[0];

          // Title matches provided metadata
          expect(searchResult.title).toBe(meta.title);
          expect(searchResult.title.length).toBeGreaterThan(0);

          // Status matches provided metadata
          expect(searchResult.status).toBe(meta.status);
          expect(VALID_STATUSES).toContain(searchResult.status);

          // Date is valid ISO 8601
          expect(searchResult.date).toBe(meta.createdAt);
          const parsedDate = new Date(searchResult.date);
          expect(parsedDate.toString()).not.toBe('Invalid Date');

          // Similarity score in [0, 1]
          expect(searchResult.similarityScore).toBeGreaterThanOrEqual(0);
          expect(searchResult.similarityScore).toBeLessThanOrEqual(1);

          // Summary ≤200 characters
          expect(searchResult.summary.length).toBeLessThanOrEqual(200);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 23: Search completes within timeout
// =============================================================================

/**
 * Property 23: Search completes within timeout
 *
 * For any valid search query, `semanticSearch` either returns within 2,000ms
 * or returns a timeout error; operation is cancelled on timeout.
 *
 * **Validates: Requirements 7.1**
 */
describe('Property 23: Search completes within timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('when generateTitanEmbedding never resolves (hangs), semanticSearch returns TIMEOUT error after 2000ms', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        async (roomId, queryText) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to never resolve (simulates a hang)
          mockGenerateTitanEmbedding.mockReturnValue(new Promise(() => {}));

          // Start the search (does not await yet)
          const resultPromise = semanticSearch({
            roomId,
            query: queryText,
          });

          // Advance time past the 2000ms timeout
          await vi.advanceTimersByTimeAsync(2001);

          const result = await resultPromise;

          // Must return an error result with TIMEOUT kind
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('TIMEOUT');
            if (result.error.kind === 'TIMEOUT') {
              expect(result.error.elapsedMs).toBeGreaterThanOrEqual(2000);
            }
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('when generateTitanEmbedding resolves quickly, semanticSearch returns results normally (no timeout)', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        embeddingVectorArb,
        async (roomId, queryText, queryEmbedding) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to resolve immediately with a valid embedding
          mockGenerateTitanEmbedding.mockResolvedValue({
            ok: true,
            value: queryEmbedding,
          });

          // Mock query calls: embeddings query returns empty, thread metadata returns empty
          mockQuery
            .mockResolvedValueOnce({ ok: true, value: [] })
            .mockResolvedValueOnce({ ok: true, value: [] });

          // Start the search
          const resultPromise = semanticSearch({
            roomId,
            query: queryText,
          });

          // Advance timers slightly to allow microtasks to flush
          await vi.advanceTimersByTimeAsync(10);

          const result = await resultPromise;

          // Must return a success result (no timeout)
          expect(result.ok).toBe(true);
          if (result.ok) {
            // Results should be an array (empty since no embeddings match)
            expect(Array.isArray(result.value)).toBe(true);
          }
        },
      ),
      { numRuns: 20 },
    );
  });

  it('timeout returns TIMEOUT kind regardless of query content or filters', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
        fc.option(
          fc.record({
            status: fc.constantFrom('DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED') as fc.Arbitrary<'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED'>,
            title: fc.string({ minLength: 1, maxLength: 50 }),
          }),
          { nil: undefined },
        ),
        async (roomId, queryText, filters) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Mock generateTitanEmbedding to never resolve (hang)
          mockGenerateTitanEmbedding.mockReturnValue(new Promise(() => {}));

          const resultPromise = semanticSearch({
            roomId,
            query: queryText,
            filters: filters ? { status: filters.status, title: filters.title } : undefined,
          });

          // Advance time past the 2000ms timeout
          await vi.advanceTimersByTimeAsync(2001);

          const result = await resultPromise;

          // Must return TIMEOUT error
          expect(result.ok).toBe(false);
          if (!result.ok) {
            expect(result.error.kind).toBe('TIMEOUT');
          }
        },
      ),
      { numRuns: 20 },
    );
  });
});


// =============================================================================
// Property 13: Structured filters intersect correctly with results
// =============================================================================

/**
 * Property 13: Structured filters intersect correctly with results
 *
 * For any combination of filters, every result satisfies ALL applied criteria
 * simultaneously; results not matching any filter are excluded.
 *
 * **Validates: Requirements 7.2**
 */

describe('Property 13: Structured filters intersect correctly with results', () => {
  beforeEach(() => {
    mockGenerateTitanEmbedding.mockReset();
    mockQuery.mockReset();
    mockPutItem.mockReset();
  });

  // Generators for filter testing
  const threadStatusArb = fc.constantFrom('DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED') as fc.Arbitrary<'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED'>;

  const titleArb = fc.string({ minLength: 1, maxLength: 30 }).filter((s) => s.trim().length > 0);

  /** Generates a date within a reasonable range. */
  const dateArb = fc.date({ min: new Date('2022-01-01'), max: new Date('2026-12-31') });

  /** Generates a date range where `from` <= `to`. */
  const dateRangeArb = fc.tuple(dateArb, dateArb).map(([a, b]) => {
    const from = a <= b ? a : b;
    const to = a <= b ? b : a;
    return { from, to };
  });

  /** Generates a set of thread metadata items with varied statuses, titles, and dates. */
  function threadMetadataArb(count: number) {
    return fc.array(
      fc.record({
        threadId: fc.uuid(),
        title: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
        status: threadStatusArb,
        createdAt: dateArb.map((d) => d.toISOString()),
      }),
      { minLength: count, maxLength: count },
    );
  }

  /** Small embedding dimension for fast tests. */
  const FILTER_TEST_DIM = 8;

  /** Generates a high-similarity embedding (close to the query vector) so similarity threshold is met. */
  function highSimilarityEmbeddingArb(queryEmbedding: number[]): fc.Arbitrary<number[]> {
    // Generate vectors that are a small perturbation of the query so cosine similarity >= 0.7
    return fc.array(
      fc.double({ min: -0.1, max: 0.1, noNaN: true, noDefaultInfinity: true }),
      { minLength: queryEmbedding.length, maxLength: queryEmbedding.length },
    ).map((noise) => queryEmbedding.map((v, i) => v + noise[i]));
  }

  it('when status filter is applied, ALL results have the specified status', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), // query
        threadStatusArb, // status filter
        fc.integer({ min: 3, max: 10 }), // number of threads
        async (roomId, queryText, statusFilter, threadCount) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          // Generate a fixed query embedding
          const queryEmbedding = Array.from({ length: FILTER_TEST_DIM }, (_, i) => (i + 1) * 0.1);

          // Generate thread metadata with mixed statuses
          const statuses: Array<'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED'> = ['DRAFT', 'IN_PROGRESS', 'DECIDED', 'SUPERSEDED'];
          const threads = Array.from({ length: threadCount }, (_, idx) => ({
            threadId: `thread-${idx}`,
            title: `Thread Title ${idx}`,
            status: statuses[idx % statuses.length],
            createdAt: new Date(2024, 0, idx + 1).toISOString(),
            updatedAt: new Date(2024, 0, idx + 1).toISOString(),
          }));

          // Build embedding items all with high similarity to query
          const embeddingItems: EmbeddingItem[] = threads.map((t) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#${t.threadId}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: t.threadId,
            entityTypeRef: 'THREAD' as const,
            embedding: queryEmbedding, // Same as query => similarity = 1
            textSummary: `Summary for ${t.title}`,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          // Mock embedding generation
          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          // Mock DynamoDB queries:
          // 1st call: embeddings query
          // 2nd call: thread items for filtering
          // 3rd call: thread items for result mapping
          const threadDbItems = threads.map((t) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#${t.threadId}`,
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            filters: { status: statusFilter },
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Every result must have the specified status
          for (const r of result.value) {
            expect(r.status).toBe(statusFilter);
          }

          // Verify exclusion: count expected matches
          const expectedCount = threads.filter((t) => t.status === statusFilter).length;
          expect(result.value.length).toBe(expectedCount);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('when dateRange filter is applied, ALL results fall within the range', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), // query
        dateRangeArb, // date range filter
        async (roomId, queryText, dateRange) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const queryEmbedding = Array.from({ length: FILTER_TEST_DIM }, (_, i) => (i + 1) * 0.1);

          // Create threads spread across different dates (some inside, some outside range)
          const dates = [
            new Date('2022-06-15'),
            new Date('2023-03-01'),
            new Date('2024-01-15'),
            new Date('2024-07-20'),
            new Date('2025-02-10'),
            new Date('2026-11-30'),
          ];

          const threads = dates.map((d, idx) => ({
            threadId: `thread-${idx}`,
            title: `Thread ${idx}`,
            status: 'DECIDED' as const,
            createdAt: d.toISOString(),
            updatedAt: d.toISOString(),
          }));

          const embeddingItems: EmbeddingItem[] = threads.map((t) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#${t.threadId}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: t.threadId,
            entityTypeRef: 'THREAD' as const,
            embedding: queryEmbedding, // Same as query => similarity = 1
            textSummary: `Summary for ${t.title}`,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          const threadDbItems = threads.map((t) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#${t.threadId}`,
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            filters: { dateRange },
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Every result must have date within the range
          for (const r of result.value) {
            const resultDate = new Date(r.date);
            expect(resultDate.getTime()).toBeGreaterThanOrEqual(dateRange.from.getTime());
            expect(resultDate.getTime()).toBeLessThanOrEqual(dateRange.to.getTime());
          }

          // Results that are outside range must be excluded
          const expectedInRange = threads.filter((t) => {
            const d = new Date(t.createdAt);
            return d >= dateRange.from && d <= dateRange.to;
          });
          expect(result.value.length).toBe(expectedInRange.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('when title filter is applied, ALL result titles contain the filter string (case-insensitive)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), // query
        fc.constantFrom('arch', 'deploy', 'data', 'api'), // title filter substring
        async (roomId, queryText, titleFilter) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const queryEmbedding = Array.from({ length: FILTER_TEST_DIM }, (_, i) => (i + 1) * 0.1);

          // Create threads with various titles, some matching the filter
          const titles = [
            'Architecture Review',
            'Deployment Pipeline',
            'Data Migration Strategy',
            'API Gateway Selection',
            'Security Audit Plan',
            'Cost Optimization',
          ];

          const threads = titles.map((title, idx) => ({
            threadId: `thread-${idx}`,
            title,
            status: 'IN_PROGRESS' as const,
            createdAt: new Date(2024, 0, idx + 1).toISOString(),
            updatedAt: new Date(2024, 0, idx + 1).toISOString(),
          }));

          const embeddingItems: EmbeddingItem[] = threads.map((t) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#${t.threadId}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: t.threadId,
            entityTypeRef: 'THREAD' as const,
            embedding: queryEmbedding,
            textSummary: `Summary for ${t.title}`,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          const threadDbItems = threads.map((t) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#${t.threadId}`,
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
          }));

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            filters: { title: titleFilter },
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Every result title must contain the filter string (case-insensitive)
          for (const r of result.value) {
            expect(r.title.toLowerCase()).toContain(titleFilter.toLowerCase());
          }

          // Verify exclusion: count expected matches
          const expectedCount = threads.filter(
            (t) => t.title.toLowerCase().includes(titleFilter.toLowerCase()),
          ).length;
          expect(result.value.length).toBe(expectedCount);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('when ALL filters are applied simultaneously, every result satisfies ALL criteria', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), // query
        threadStatusArb, // status filter
        async (roomId, queryText, statusFilter) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const queryEmbedding = Array.from({ length: FILTER_TEST_DIM }, (_, i) => (i + 1) * 0.1);

          // Fixed date range for predictable testing
          const dateRange = {
            from: new Date('2024-03-01'),
            to: new Date('2024-09-30'),
          };
          const titleFilter = 'decision';

          // Create threads with various combinations of attributes
          const threads = [
            { threadId: 'thread-0', title: 'Decision Architecture', status: 'DECIDED' as const, createdAt: new Date('2024-05-15').toISOString() },
            { threadId: 'thread-1', title: 'Decision Review', status: 'IN_PROGRESS' as const, createdAt: new Date('2024-06-20').toISOString() },
            { threadId: 'thread-2', title: 'Decision Deploy', status: 'DRAFT' as const, createdAt: new Date('2024-04-10').toISOString() },
            { threadId: 'thread-3', title: 'API Selection', status: 'DECIDED' as const, createdAt: new Date('2024-07-01').toISOString() },
            { threadId: 'thread-4', title: 'Decision Pipeline', status: 'SUPERSEDED' as const, createdAt: new Date('2024-08-01').toISOString() },
            { threadId: 'thread-5', title: 'Decision Old', status: statusFilter, createdAt: new Date('2023-01-01').toISOString() }, // outside date range
            { threadId: 'thread-6', title: 'No Match Title', status: statusFilter, createdAt: new Date('2024-05-01').toISOString() }, // title doesn't match
          ];

          const embeddingItems: EmbeddingItem[] = threads.map((t) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#${t.threadId}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: t.threadId,
            entityTypeRef: 'THREAD' as const,
            embedding: queryEmbedding,
            textSummary: `Summary for ${t.title}`,
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
          }));

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          const threadDbItems = threads.map((t) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#${t.threadId}`,
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
          }));

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems });

          const result = await semanticSearch({
            roomId,
            query: queryText,
            filters: {
              status: statusFilter,
              dateRange,
              title: titleFilter,
            },
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // Every result must satisfy ALL three filters simultaneously
          for (const r of result.value) {
            // Status filter
            expect(r.status).toBe(statusFilter);

            // Date range filter
            const resultDate = new Date(r.date);
            expect(resultDate.getTime()).toBeGreaterThanOrEqual(dateRange.from.getTime());
            expect(resultDate.getTime()).toBeLessThanOrEqual(dateRange.to.getTime());

            // Title filter (case-insensitive)
            expect(r.title.toLowerCase()).toContain(titleFilter.toLowerCase());
          }

          // Verify completeness: count expected matches that satisfy ALL criteria
          const expectedCount = threads.filter((t) => {
            const d = new Date(t.createdAt);
            return (
              t.status === statusFilter &&
              d >= dateRange.from &&
              d <= dateRange.to &&
              t.title.toLowerCase().includes(titleFilter.toLowerCase())
            );
          }).length;
          expect(result.value.length).toBe(expectedCount);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('results not matching any active filter are excluded from the output', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uuid(), // roomId
        fc.string({ minLength: 1, maxLength: 20 }).filter((s) => s.trim().length > 0), // query
        async (roomId, queryText) => {
          mockGenerateTitanEmbedding.mockReset();
          mockQuery.mockReset();

          const queryEmbedding = Array.from({ length: FILTER_TEST_DIM }, (_, i) => (i + 1) * 0.1);

          // Create threads where NONE match the filter criteria
          const threads = [
            { threadId: 'thread-0', title: 'Alpha Project', status: 'DRAFT' as const, createdAt: new Date('2024-02-15').toISOString() },
            { threadId: 'thread-1', title: 'Beta Review', status: 'IN_PROGRESS' as const, createdAt: new Date('2024-03-20').toISOString() },
            { threadId: 'thread-2', title: 'Gamma Plan', status: 'DRAFT' as const, createdAt: new Date('2024-04-10').toISOString() },
          ];

          const embeddingItems: EmbeddingItem[] = threads.map((t) => ({
            PK: `ROOM#${roomId}` as `ROOM#${string}`,
            SK: `EMB#THREAD#${t.threadId}` as `EMB#${string}#${string}`,
            entityType: 'EMBEDDING' as const,
            roomId,
            entityId: t.threadId,
            entityTypeRef: 'THREAD' as const,
            embedding: queryEmbedding,
            textSummary: `Summary for ${t.title}`,
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
          }));

          mockGenerateTitanEmbedding.mockResolvedValueOnce({
            ok: true,
            value: queryEmbedding,
          });

          const threadDbItems = threads.map((t) => ({
            PK: `ROOM#${roomId}`,
            SK: `THREAD#${t.threadId}`,
            threadId: t.threadId,
            title: t.title,
            status: t.status,
            createdAt: t.createdAt,
            updatedAt: t.createdAt,
          }));

          mockQuery
            .mockResolvedValueOnce({ ok: true, value: embeddingItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems })
            .mockResolvedValueOnce({ ok: true, value: threadDbItems });

          // Apply a filter that NO thread matches: status SUPERSEDED + title "zzz"
          const result = await semanticSearch({
            roomId,
            query: queryText,
            filters: {
              status: 'SUPERSEDED',
              title: 'zzz_nonexistent',
            },
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          // No results should be returned since no thread matches
          expect(result.value.length).toBe(0);
        },
      ),
      { numRuns: 50 },
    );
  });
});
