import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  ThrottlingException,
  ValidationException,
} from '@aws-sdk/client-bedrock-runtime';
import { Result, ok, err } from '@/types/result';

export type BedrockError =
  | { kind: 'INVOCATION_FAILURE'; statusCode: number; message: string }
  | { kind: 'THROTTLED'; retryAfterMs: number }
  | { kind: 'VALIDATION_ERROR'; message: string };

const CLAUDE_MODEL_ID =
  process.env.BEDROCK_CLAUDE_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6';
const TITAN_MODEL_ID =
  process.env.BEDROCK_TITAN_MODEL_ID ?? 'amazon.titan-embed-text-v2:0';
const AWS_REGION = process.env.AWS_REGION ?? 'us-east-1';

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 200;

let clientInstance: BedrockRuntimeClient | null = null;

function getClient(): BedrockRuntimeClient {
  if (!clientInstance) {
    clientInstance = new BedrockRuntimeClient({ region: AWS_REGION });
  }
  return clientInstance;
}

/**
 * Determines whether an error is transient and eligible for retry.
 */
function isTransientError(error: unknown): boolean {
  if (error instanceof ThrottlingException) return true;
  if (error instanceof Error && 'name' in error) {
    return (
      error.name === 'ThrottlingException' ||
      error.name === 'ServiceUnavailableException' ||
      error.name === 'InternalServerException'
    );
  }
  return false;
}

/**
 * Maps an AWS SDK error to a typed BedrockError.
 */
function mapError(error: unknown): BedrockError {
  if (error instanceof ThrottlingException) {
    return { kind: 'THROTTLED', retryAfterMs: BASE_DELAY_MS * 2 };
  }
  if (error instanceof ValidationException) {
    return { kind: 'VALIDATION_ERROR', message: error.message };
  }
  if (error instanceof Error && 'name' in error && error.name === 'ValidationException') {
    return { kind: 'VALIDATION_ERROR', message: error.message };
  }
  const statusCode =
    error instanceof Error && '$metadata' in (error as unknown as Record<string, unknown>)
      ? ((error as unknown as Record<string, unknown>).$metadata as { httpStatusCode?: number })
          ?.httpStatusCode ?? 500
      : 500;
  const message = error instanceof Error ? error.message : 'Unknown invocation error';
  return { kind: 'INVOCATION_FAILURE', statusCode, message };
}

/**
 * Delays execution for a given number of milliseconds.
 */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Invokes Amazon Bedrock Claude model for AI reasoning.
 * Retries up to 3 times for transient/throttled errors with exponential backoff.
 */
export async function invokeClaudeModel(params: {
  systemPrompt: string;
  messages: { role: 'user' | 'assistant'; content: string }[];
  maxTokens?: number;
  temperature?: number;
}): Promise<Result<string, BedrockError>> {
  const { systemPrompt, messages, maxTokens = 4096, temperature = 0.7 } = params;
  const client = getClient();

  const body = JSON.stringify({
    anthropic_version: 'bedrock-2023-05-31',
    max_tokens: maxTokens,
    temperature,
    system: systemPrompt,
    messages: messages.map((m) => ({
      role: m.role,
      content: m.content,
    })),
  });

  let lastError: BedrockError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }

    try {
      const command = new InvokeModelCommand({
        modelId: CLAUDE_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      const content = responseBody.content;
      if (Array.isArray(content) && content.length > 0 && content[0].type === 'text') {
        return ok(content[0].text);
      }

      return ok(typeof content === 'string' ? content : JSON.stringify(content));
    } catch (error: unknown) {
      if (error instanceof ValidationException) {
        return err(mapError(error));
      }

      lastError = mapError(error);

      if (!isTransientError(error) || attempt === MAX_RETRIES) {
        return err(lastError);
      }
    }
  }

  return err(lastError ?? { kind: 'INVOCATION_FAILURE', statusCode: 500, message: 'Retries exhausted' });
}

/**
 * Generates an embedding vector using Amazon Bedrock Titan Embeddings.
 * Retries up to 3 times for transient/throttled errors with exponential backoff.
 */
export async function generateTitanEmbedding(
  text: string
): Promise<Result<number[], BedrockError>> {
  const client = getClient();

  const body = JSON.stringify({
    inputText: text,
  });

  let lastError: BedrockError | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await delay(BASE_DELAY_MS * Math.pow(2, attempt - 1));
    }

    try {
      const command = new InvokeModelCommand({
        modelId: TITAN_MODEL_ID,
        contentType: 'application/json',
        accept: 'application/json',
        body: new TextEncoder().encode(body),
      });

      const response = await client.send(command);
      const responseBody = JSON.parse(new TextDecoder().decode(response.body));

      const embedding: number[] = responseBody.embedding;
      if (!Array.isArray(embedding)) {
        return err({
          kind: 'INVOCATION_FAILURE',
          statusCode: 500,
          message: 'Response did not contain an embedding array',
        });
      }

      return ok(embedding);
    } catch (error: unknown) {
      if (error instanceof ValidationException) {
        return err(mapError(error));
      }

      lastError = mapError(error);

      if (!isTransientError(error) || attempt === MAX_RETRIES) {
        return err(lastError);
      }
    }
  }

  return err(lastError ?? { kind: 'INVOCATION_FAILURE', statusCode: 500, message: 'Retries exhausted' });
}
