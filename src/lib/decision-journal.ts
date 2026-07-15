import { Result, ok, err } from '@/types/result';
import { SearchResult, ThreadStatus, EmbeddingItem, ThreadId } from '@/types/domain';
import { generateTitanEmbedding } from '@/services/bedrock';
import { putItem, query } from '@/services/dynamo';

// =============================================================================
// Error Types
// =============================================================================

export type SearchError =
  | { kind: 'EMPTY_QUERY' }
  | { kind: 'EMBEDDING_FAILURE'; cause: string }
  | { kind: 'QUERY_FAILURE'; cause: string }
  | { kind: 'TIMEOUT'; elapsedMs: number };

// =============================================================================
// Constants
// =============================================================================

const SEARCH_TIMEOUT_MS = 2_000;
const DEFAULT_MIN_SIMILARITY = 0.7;
const MAX_RESULTS = 50;
const MAX_SUMMARY_LENGTH = 200;

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Computes the cosine similarity between two equal-dimension vectors.
 * Returns 0 for zero-length vectors to avoid division by zero.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);

  if (magnitude === 0) {
    return 0;
  }

  // Clamp to [-1, 1] to handle floating-point precision errors
  return Math.max(-1, Math.min(1, dotProduct / magnitude));
}

/**
 * Generates an embedding vector for the given text using Amazon Bedrock Titan Embeddings.
 * Wraps the Bedrock service call and maps errors to SearchError.
 */
export async function generateEmbedding(text: string): Promise<Result<number[], SearchError>> {
  const result = await generateTitanEmbedding(text);

  if (!result.ok) {
    const cause =
      result.error.kind === 'INVOCATION_FAILURE'
        ? result.error.message
        : result.error.kind === 'THROTTLED'
          ? `Throttled, retry after ${result.error.retryAfterMs}ms`
          : result.error.message;

    return err({ kind: 'EMBEDDING_FAILURE', cause });
  }

  return ok(result.value);
}

/**
 * Indexes a thread or ADR entity by generating a Titan embedding and persisting it
 * to DynamoDB with the EMB#{entityType}#{entityId} sort key pattern.
 * Called on create/update of threads and ADRs.
 */
export async function indexEntity(params: {
  roomId: string;
  entityId: string;
  entityType: 'THREAD' | 'ADR';
  content: string;
  summary: string;
}): Promise<Result<{ embedding: number[] }, SearchError>> {
  // Generate embedding for the content
  const embeddingResult = await generateEmbedding(params.content);

  if (!embeddingResult.ok) {
    return embeddingResult;
  }

  const embedding = embeddingResult.value;
  const now = new Date().toISOString();

  // Truncate summary to 200 characters
  const truncatedSummary = params.summary.slice(0, MAX_SUMMARY_LENGTH);

  // Upsert embedding item to DynamoDB
  const embeddingItem: EmbeddingItem & Record<string, unknown> = {
    PK: `ROOM#${params.roomId}`,
    SK: `EMB#${params.entityType}#${params.entityId}`,
    entityType: 'EMBEDDING',
    roomId: params.roomId,
    entityId: params.entityId,
    entityTypeRef: params.entityType,
    embedding,
    textSummary: truncatedSummary,
    createdAt: now,
    updatedAt: now,
  };

  const writeResult = await putItem({ item: embeddingItem });

  if (!writeResult.ok) {
    const cause =
      writeResult.error.kind === 'WRITE_FAILURE'
        ? writeResult.error.cause
        : writeResult.error.kind === 'CONDITION_CHECK_FAILED'
          ? writeResult.error.message
          : 'Unknown persistence error';

    return err({ kind: 'QUERY_FAILURE', cause });
  }

  return ok({ embedding });
}

/**
 * Performs semantic search across all indexed entities in a room.
 * Rejects empty/whitespace queries, generates a query embedding, computes cosine similarity
 * against stored embeddings, applies structured filters, and returns results ranked by similarity.
 * Enforces a 2-second timeout.
 */
export async function semanticSearch(params: {
  roomId: string;
  query: string;
  filters?: {
    status?: ThreadStatus;
    dateRange?: { from: Date; to: Date };
    title?: string;
  };
  limit?: number;
  minSimilarity?: number;
}): Promise<Result<SearchResult[], SearchError>> {
  // Reject empty/whitespace queries
  if (!params.query || params.query.trim().length === 0) {
    return err({ kind: 'EMPTY_QUERY' });
  }

  const startTime = Date.now();
  const limit = Math.min(params.limit ?? MAX_RESULTS, MAX_RESULTS);
  const minSimilarity = params.minSimilarity ?? DEFAULT_MIN_SIMILARITY;

  // Race the search operation against the timeout
  const timeoutPromise = new Promise<Result<SearchResult[], SearchError>>((resolve) => {
    setTimeout(() => {
      const elapsed = Date.now() - startTime;
      resolve(err({ kind: 'TIMEOUT', elapsedMs: elapsed }));
    }, SEARCH_TIMEOUT_MS);
  });

  const searchPromise = executeSearch(params.roomId, params.query, params.filters, limit, minSimilarity);

  return Promise.race([searchPromise, timeoutPromise]);
}

// =============================================================================
// Private Functions
// =============================================================================

/**
 * Executes the core search logic: embedding generation, DynamoDB query,
 * cosine similarity computation, filtering, and ranking.
 */
async function executeSearch(
  roomId: string,
  queryText: string,
  filters: {
    status?: ThreadStatus;
    dateRange?: { from: Date; to: Date };
    title?: string;
  } | undefined,
  limit: number,
  minSimilarity: number
): Promise<Result<SearchResult[], SearchError>> {
  // Generate embedding for the search query
  const queryEmbeddingResult = await generateEmbedding(queryText);

  if (!queryEmbeddingResult.ok) {
    return queryEmbeddingResult;
  }

  const queryEmbedding = queryEmbeddingResult.value;

  // Query all embedding items in the room
  const embeddingsResult = await query<EmbeddingItem>({
    pk: `ROOM#${roomId}`,
    skPrefix: 'EMB#',
  });

  if (!embeddingsResult.ok) {
    const cause =
      embeddingsResult.error.kind === 'READ_FAILURE'
        ? embeddingsResult.error.cause
        : 'Unknown query error';

    return err({ kind: 'QUERY_FAILURE', cause });
  }

  const embeddings = embeddingsResult.value;

  // Compute cosine similarity for each stored embedding
  const scoredResults: {
    entityId: string;
    entityType: 'THREAD' | 'ADR';
    similarity: number;
    summary: string;
    updatedAt: string;
  }[] = [];

  for (const item of embeddings) {
    if (!item.embedding || item.embedding.length === 0) {
      continue;
    }

    const similarity = cosineSimilarity(queryEmbedding, item.embedding);

    if (similarity >= minSimilarity) {
      scoredResults.push({
        entityId: item.entityId,
        entityType: item.entityTypeRef,
        similarity,
        summary: item.textSummary,
        updatedAt: item.updatedAt,
      });
    }
  }

  // Sort by similarity in descending order
  scoredResults.sort((a, b) => b.similarity - a.similarity);

  // To apply structured filters, we need thread/ADR metadata.
  // For now, we query thread items to get status, title, and date info.
  let filteredResults = scoredResults;

  if (filters && (filters.status || filters.dateRange || filters.title)) {
    // Query thread items to apply filters
    const threadItemsResult = await query<{
      PK: string;
      SK: string;
      threadId: string;
      title: string;
      status: ThreadStatus;
      createdAt: string;
      updatedAt: string;
    }>({
      pk: `ROOM#${roomId}`,
      skPrefix: 'THREAD#',
    });

    if (!threadItemsResult.ok) {
      const cause =
        threadItemsResult.error.kind === 'READ_FAILURE'
          ? threadItemsResult.error.cause
          : 'Unknown query error';

      return err({ kind: 'QUERY_FAILURE', cause });
    }

    const threadMap = new Map<string, { title: string; status: ThreadStatus; createdAt: string }>();
    for (const t of threadItemsResult.value) {
      threadMap.set(t.threadId, { title: t.title, status: t.status, createdAt: t.createdAt });
    }

    filteredResults = scoredResults.filter((result) => {
      const threadData = threadMap.get(result.entityId);
      if (!threadData) {
        // If we can't find thread metadata for a filter check, exclude it
        // unless no thread-specific filters are applied
        return false;
      }

      // Status filter
      if (filters.status && threadData.status !== filters.status) {
        return false;
      }

      // Date range filter
      if (filters.dateRange) {
        const createdDate = new Date(threadData.createdAt);
        if (createdDate < filters.dateRange.from || createdDate > filters.dateRange.to) {
          return false;
        }
      }

      // Title filter (case-insensitive substring match)
      if (filters.title) {
        if (!threadData.title.toLowerCase().includes(filters.title.toLowerCase())) {
          return false;
        }
      }

      return true;
    });
  }

  // Limit results
  const limitedResults = filteredResults.slice(0, limit);

  // Map to SearchResult format
  // We need thread metadata for the final results
  const threadItemsForResultsResult = await query<{
    PK: string;
    SK: string;
    threadId: string;
    title: string;
    status: ThreadStatus;
    createdAt: string;
  }>({
    pk: `ROOM#${roomId}`,
    skPrefix: 'THREAD#',
  });

  let threadMetadataMap = new Map<string, { title: string; status: ThreadStatus; date: string }>();

  if (threadItemsForResultsResult.ok) {
    for (const t of threadItemsForResultsResult.value) {
      threadMetadataMap.set(t.threadId, {
        title: t.title,
        status: t.status,
        date: t.createdAt,
      });
    }
  }

  const searchResults: SearchResult[] = limitedResults.map((result) => {
    const metadata = threadMetadataMap.get(result.entityId);

    return {
      threadId: result.entityId as ThreadId,
      title: metadata?.title ?? result.entityId,
      status: metadata?.status ?? ('IN_PROGRESS' as ThreadStatus),
      date: metadata?.date ?? result.updatedAt,
      similarityScore: result.similarity,
      summary: result.summary,
    };
  });

  return ok(searchResults);
}
