import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { Result, ok, err } from '@/types/result';

// --- Error Types ---

export type DynamoError =
  | { kind: 'WRITE_FAILURE'; cause: string }
  | { kind: 'READ_FAILURE'; cause: string }
  | { kind: 'CONDITION_CHECK_FAILED'; message: string }
  | { kind: 'RETRIES_EXHAUSTED'; attempts: number; lastError: string };

// --- Singleton Client ---

const TABLE_NAME = process.env.CHALK_TABLE_NAME ?? 'ChalkTable';

const dynamoClient = new DynamoDBClient({});

export const docClient = DynamoDBDocumentClient.from(dynamoClient, {
  marshallOptions: {
    removeUndefinedValues: true,
  },
});

// --- Service Functions ---

export async function putItem<T extends Record<string, unknown>>(params: {
  item: T;
  conditionExpression?: string;
}): Promise<Result<T, DynamoError>> {
  try {
    const command = new PutCommand({
      TableName: TABLE_NAME,
      Item: params.item,
      ...(params.conditionExpression && {
        ConditionExpression: params.conditionExpression,
      }),
    });

    await docClient.send(command);
    return ok(params.item);
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      error.name === 'ConditionalCheckFailedException'
    ) {
      return err({
        kind: 'CONDITION_CHECK_FAILED',
        message: error.message,
      });
    }

    const cause =
      error instanceof Error ? error.message : 'Unknown write error';
    return err({ kind: 'WRITE_FAILURE', cause });
  }
}

export async function getItem<T>(params: {
  pk: string;
  sk: string;
}): Promise<Result<T | null, DynamoError>> {
  try {
    const command = new GetCommand({
      TableName: TABLE_NAME,
      Key: {
        PK: params.pk,
        SK: params.sk,
      },
    });

    const response = await docClient.send(command);
    return ok((response.Item as T) ?? null);
  } catch (error: unknown) {
    const cause =
      error instanceof Error ? error.message : 'Unknown read error';
    return err({ kind: 'READ_FAILURE', cause });
  }
}

export async function query<T>(params: {
  pk: string;
  skPrefix?: string;
  indexName?: string;
  limit?: number;
  filterExpression?: string;
}): Promise<Result<T[], DynamoError>> {
  try {
    const keyConditionExpression = params.skPrefix
      ? 'PK = :pk AND begins_with(SK, :skPrefix)'
      : 'PK = :pk';

    const expressionAttributeValues: Record<string, string> = {
      ':pk': params.pk,
    };

    if (params.skPrefix) {
      expressionAttributeValues[':skPrefix'] = params.skPrefix;
    }

    const command = new QueryCommand({
      TableName: TABLE_NAME,
      ...(params.indexName && { IndexName: params.indexName }),
      KeyConditionExpression: keyConditionExpression,
      ExpressionAttributeValues: expressionAttributeValues,
      ...(params.limit && { Limit: params.limit }),
      ...(params.filterExpression && {
        FilterExpression: params.filterExpression,
      }),
    });

    const response = await docClient.send(command);
    return ok((response.Items as T[]) ?? []);
  } catch (error: unknown) {
    const cause =
      error instanceof Error ? error.message : 'Unknown read error';
    return err({ kind: 'READ_FAILURE', cause });
  }
}

export async function putItemWithRetry<T extends Record<string, unknown>>(
  item: T,
  maxRetries: number = 3,
  baseDelayMs: number = 100
): Promise<Result<T, DynamoError>> {
  let lastError = '';

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const result = await putItem({ item });

    if (result.ok) {
      return result;
    }

    // Don't retry condition check failures — they are intentional rejections
    if (result.error.kind === 'CONDITION_CHECK_FAILED') {
      return result;
    }

    lastError =
      result.error.kind === 'WRITE_FAILURE'
        ? result.error.cause
        : 'Unknown error';

    // If this isn't the last attempt, wait with exponential backoff
    if (attempt < maxRetries) {
      const delay = baseDelayMs * Math.pow(2, attempt);
      await sleep(delay);
    }
  }

  return err({
    kind: 'RETRIES_EXHAUSTED',
    attempts: maxRetries + 1,
    lastError,
  });
}

// --- Helpers ---

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
