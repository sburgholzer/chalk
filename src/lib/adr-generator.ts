import { z } from 'zod';
import { type Result, ok, err } from '@/types/result';
import { type ADR, type DecisionThread, type CrossReference, type RoomId } from '@/types/domain';
import { invokeClaudeModel } from '@/services/bedrock';
import { uploadDocument } from '@/services/s3';
import { query } from '@/services/dynamo';

// =============================================================================
// Error Types
// =============================================================================

export type ADRError =
  | { kind: 'INSUFFICIENT_CONTEXT'; missingSections: string[] }
  | { kind: 'GENERATION_FAILURE'; cause: string; attempt: number }
  | { kind: 'S3_UPLOAD_FAILURE'; cause: string }
  | { kind: 'TIMEOUT'; elapsedMs: number };

// =============================================================================
// Constants
// =============================================================================

/** ADR generation must complete within 30 seconds (Requirement 5.2). */
export const ADR_GENERATION_TIMEOUT_MS = 30_000;

/** Maximum number of generation attempts (including timeout retries). */
const MAX_GENERATION_ATTEMPTS = 3;

/** Required sections that every ADR must contain. */
const REQUIRED_ADR_SECTIONS = [
  'identifier',
  'title',
  'date',
  'status',
  'context',
  'options',
  'decision',
  'consequences',
] as const;

// =============================================================================
// Zod Validation Schema
// =============================================================================

const adrResponseSchema = z.object({
  title: z.string().min(1),
  context: z.string().min(1),
  optionsConsidered: z
    .array(
      z.object({
        name: z.string().min(1),
        summary: z.string().min(1),
      })
    )
    .min(2),
  decision: z.string().min(1),
  consequences: z.string().min(1),
});

// =============================================================================
// Sequential ID Generation
// =============================================================================

/**
 * Retrieves the next sequential ADR ID for a room by querying GSI3.
 * Returns the next number (e.g., if the last ADR is ADR-003, returns 4).
 */
export async function getNextSequentialId(roomId: RoomId): Promise<Result<number, ADRError>> {
  const result = await query<{ sequentialId: number }>({
    pk: `ROOM#${roomId}`,
    skPrefix: 'ADR_SEQ#',
    indexName: 'GSI3',
    limit: 1,
  });

  if (!result.ok) {
    return err({
      kind: 'GENERATION_FAILURE',
      cause: `Failed to query sequential ID: ${result.error.kind}`,
      attempt: 0,
    });
  }

  const items = result.value;
  if (items.length === 0) {
    return ok(1);
  }

  return ok(items[0].sequentialId + 1);
}

/**
 * Formats a sequential ID as zero-padded 3-digit string (e.g., 1 → "001").
 */
export function formatSequentialId(id: number): string {
  return String(id).padStart(3, '0');
}

// =============================================================================
// Context Validation
// =============================================================================

/**
 * Validates that the thread has sufficient context for ADR generation.
 * Returns a list of missing sections if context is insufficient.
 */
function validateThreadContext(
  thread: DecisionThread,
  selectedOption: string
): Result<void, ADRError> {
  const missingSections: string[] = [];

  if (!thread.title || thread.title.trim().length === 0) {
    missingSections.push('title');
  }

  if (thread.status !== 'DECIDED') {
    missingSections.push('status');
  }

  if (!selectedOption || selectedOption.trim().length === 0) {
    missingSections.push('decision');
  }

  // A thread needs at least the title and a selected option to generate context
  if (!thread.threadId) {
    missingSections.push('identifier');
  }

  if (missingSections.length > 0) {
    return err({ kind: 'INSUFFICIENT_CONTEXT', missingSections });
  }

  return ok(undefined);
}

// =============================================================================
// ADR Generation
// =============================================================================

/**
 * Invokes Bedrock Claude with a timeout. Returns the raw response or a timeout error.
 */
async function invokeWithTimeout(
  systemPrompt: string,
  messages: { role: 'user' | 'assistant'; content: string }[]
): Promise<Result<string, ADRError>> {
  const timeoutPromise = new Promise<Result<string, ADRError>>((resolve) => {
    setTimeout(() => {
      resolve(err({ kind: 'TIMEOUT', elapsedMs: ADR_GENERATION_TIMEOUT_MS }));
    }, ADR_GENERATION_TIMEOUT_MS);
  });

  const generationPromise = (async (): Promise<Result<string, ADRError>> => {
    const result = await invokeClaudeModel({
      systemPrompt,
      messages,
      maxTokens: 4096,
      temperature: 0.3,
    });

    if (!result.ok) {
      return err({
        kind: 'GENERATION_FAILURE',
        cause: `Bedrock invocation failed: ${result.error.kind} - ${
          'message' in result.error ? result.error.message : 'unknown'
        }`,
        attempt: 0,
      });
    }

    return ok(result.value);
  })();

  return Promise.race([generationPromise, timeoutPromise]);
}

/**
 * Builds the system prompt for ADR generation.
 */
function buildADRSystemPrompt(crossReferences: CrossReference[]): string {
  const relatedSection =
    crossReferences.length > 0
      ? `\nInclude a "Related Decisions" section referencing these prior decisions:\n${crossReferences
          .map(
            (ref) =>
              `- ${ref.targetThreadId} (${ref.referenceType}): ${ref.description}`
          )
          .join('\n')}`
      : '';

  return `You are an expert architecture documentation writer. Generate a structured Architecture Decision Record (ADR) from the provided decision thread context.

Your response MUST be valid JSON with the following structure:
{
  "title": "concise title for the ADR",
  "context": "description of the problem and constraints that led to the decision",
  "optionsConsidered": [
    { "name": "Option Name", "summary": "brief description of this option" }
  ],
  "decision": "the chosen option and the rationale",
  "consequences": "expected outcomes, risks, and follow-up actions"
}

Requirements:
- The title should be concise and descriptive
- The context section should summarize the problem, constraints, and motivation
- Include at least 2 options that were considered
- The decision should clearly state what was chosen and why
- The consequences should cover both positive outcomes and potential risks
${relatedSection}

Respond ONLY with valid JSON. No markdown, no code fences, no additional text.`;
}

/**
 * Builds the user prompt with thread context for ADR generation.
 */
function buildADRUserPrompt(
  thread: DecisionThread,
  selectedOption: string
): string {
  return `Generate an ADR for the following decided architecture thread:

Thread Title: ${thread.title}
Thread ID: ${thread.threadId}
Room ID: ${thread.roomId}
Status: ${thread.status}
Created: ${thread.createdAt}
Decision Date: ${thread.updatedAt}
Selected Option: ${selectedOption}

Please synthesize this into a complete ADR document.`;
}

/**
 * Generates an ADR from a decided thread's context.
 *
 * - Validates the thread has sufficient context
 * - Invokes Bedrock Claude with a 30-second timeout
 * - Retries up to 3 times on timeout or generation failure
 * - Validates the response structure with Zod
 * - Maps cross-references to the "Related Decisions" section
 *
 * Requirements: 5.1, 5.2, 5.3, 5.6, 5.7
 */
export async function generateADR(params: {
  thread: DecisionThread;
  selectedOption: string;
  crossReferences: CrossReference[];
  nextSequentialId: number;
}): Promise<Result<ADR, ADRError>> {
  const { thread, selectedOption, crossReferences, nextSequentialId } = params;

  // Validate thread has sufficient context (Requirement 5.6)
  const validation = validateThreadContext(thread, selectedOption);
  if (!validation.ok) {
    return validation as Result<never, ADRError>;
  }

  const systemPrompt = buildADRSystemPrompt(crossReferences);
  const userMessages: { role: 'user' | 'assistant'; content: string }[] = [
    { role: 'user', content: buildADRUserPrompt(thread, selectedOption) },
  ];

  // Retry loop — up to 3 attempts (Requirement 5.7 + timeout retries)
  for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
    const result = await invokeWithTimeout(systemPrompt, userMessages);

    if (!result.ok) {
      // On the last attempt, return the error
      if (attempt === MAX_GENERATION_ATTEMPTS) {
        if (result.error.kind === 'TIMEOUT') {
          return err(result.error);
        }
        return err({
          kind: 'GENERATION_FAILURE',
          cause: result.error.kind === 'GENERATION_FAILURE' ? result.error.cause : 'Timeout',
          attempt,
        });
      }
      // Otherwise retry
      continue;
    }

    // Parse and validate the response with Zod
    let parsed: z.infer<typeof adrResponseSchema>;
    try {
      const rawJson = JSON.parse(result.value);
      parsed = adrResponseSchema.parse(rawJson);
    } catch (parseError: unknown) {
      if (attempt === MAX_GENERATION_ATTEMPTS) {
        const message =
          parseError instanceof Error ? parseError.message : 'Invalid response structure';
        return err({
          kind: 'GENERATION_FAILURE',
          cause: `Response validation failed: ${message}`,
          attempt,
        });
      }
      // Retry on parse failure
      continue;
    }

    // Build the ADR (Requirements 5.1, 5.3)
    const now = new Date().toISOString();
    const adrId = `ADR-${formatSequentialId(nextSequentialId)}`;

    const relatedDecisions: ADR['relatedDecisions'] = crossReferences.map((ref) => ({
      adrId: ref.targetThreadId,
      title: ref.description,
      relationship: ref.referenceType,
    }));

    const adr: ADR = {
      adrId,
      roomId: thread.roomId,
      threadId: thread.threadId,
      sequentialId: nextSequentialId,
      title: parsed.title,
      status: 'ACTIVE',
      date: now,
      context: parsed.context,
      optionsConsidered: parsed.optionsConsidered,
      decision: parsed.decision,
      consequences: parsed.consequences,
      relatedDecisions,
      createdAt: now,
      updatedAt: now,
    };

    return ok(adr);
  }

  // Fallback (should not reach here due to loop logic)
  return err({
    kind: 'GENERATION_FAILURE',
    cause: 'All generation attempts exhausted',
    attempt: MAX_GENERATION_ATTEMPTS,
  });
}

// =============================================================================
// S3 Export
// =============================================================================

/**
 * Exports a structured ADR document to S3.
 *
 * The document is stored as a JSON file at:
 *   adrs/{roomId}/{adrId}.json
 *
 * Requirement: 5.5
 */
export async function exportADRToS3(adr: ADR): Promise<Result<{ s3Key: string }, ADRError>> {
  const s3Key = `adrs/${adr.roomId}/${adr.adrId}.json`;

  const documentBody = JSON.stringify(
    {
      identifier: adr.adrId,
      title: adr.title,
      date: adr.date,
      status: adr.status,
      context: adr.context,
      optionsConsidered: adr.optionsConsidered,
      decision: adr.decision,
      consequences: adr.consequences,
      relatedDecisions: adr.relatedDecisions,
      metadata: {
        roomId: adr.roomId,
        threadId: adr.threadId,
        sequentialId: adr.sequentialId,
        createdAt: adr.createdAt,
      },
    },
    null,
    2
  );

  const uploadResult = await uploadDocument({
    key: s3Key,
    body: documentBody,
    contentType: 'application/json',
  });

  if (!uploadResult.ok) {
    return err({
      kind: 'S3_UPLOAD_FAILURE',
      cause: uploadResult.error.kind === 'UPLOAD_FAILURE' ? uploadResult.error.cause : 'Upload failed',
    });
  }

  return ok({ s3Key });
}
