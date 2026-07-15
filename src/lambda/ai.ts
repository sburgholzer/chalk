/**
 * Lambda handlers for messaging and AI Architect interactions.
 *
 * Endpoints:
 * - POST /threads/:id/messages — Persist user message, invoke AI Architect, persist AI response, return both
 *
 * The handler follows the write-before-acknowledge pattern:
 * 1. Persist user message to DynamoDB
 * 2. Invoke AI Architect (assessInputSufficiency, proposeOptionsWithFallback, or regenerateTradeoffTable)
 * 3. Persist AI response to DynamoDB
 * 4. Call indexEntity to keep embeddings fresh
 * 5. Return both messages to the client
 *
 * Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 9.2, 9.3
 */

import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';
import { v4 as uuidv4 } from 'uuid';
import {
  assessInputSufficiency,
  proposeOptionsWithFallback,
  regenerateTradeoffTable,
  type AIError,
} from '@/lib/ai-architect';
import { indexEntity } from '@/lib/decision-journal';
import { putItem, query, getItem } from '@/services/dynamo';
import type {
  ThreadId,
  RoomId,
  TeamId,
  MessageId,
  MessageItem,
  ThreadItem,
  Message,
  TradeoffTable,
} from '@/types/domain';

// =============================================================================
// Types
// =============================================================================

/** Context injected by the API Gateway Cognito authorizer. */
interface AuthorizerContext {
  userId: string;
  email: string;
  teams: string; // JSON-encoded string array of TeamId
}

/** Request body for POST /threads/:id/messages. */
interface SendMessageRequest {
  content: string;
  roomId: string;
  /** Optional: new constraints that trigger tradeoff table regeneration. */
  newConstraints?: string[];
  /** Optional: previous tradeoff table for regeneration context. */
  previousTable?: TradeoffTable;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Extracts the authorizer context from the API Gateway event.
 */
function extractAuthContext(event: APIGatewayProxyEventV2): AuthorizerContext | null {
  const context = (event.requestContext as unknown as { authorizer?: { lambda?: AuthorizerContext } })
    ?.authorizer;

  if (context?.lambda?.userId && context?.lambda?.teams) {
    return context.lambda;
  }

  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;
  if (!authHeader) return null;

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') return null;

  try {
    const tokenParts = parts[1].split('.');
    if (tokenParts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64url').toString());

    const userId = payload.sub ?? payload['cognito:username'] ?? '';
    const email = payload.email ?? '';
    const groups = payload['cognito:groups'] ?? [];

    if (!userId) return null;

    return {
      userId,
      email,
      teams: JSON.stringify(groups),
    };
  } catch {
    return null;
  }
}

/**
 * Extracts the user's primary team (first team in the array).
 */
function extractTeamId(authContext: AuthorizerContext): TeamId | null {
  try {
    const teams: string[] = JSON.parse(authContext.teams);
    if (teams.length === 0) return null;
    return teams[0] as TeamId;
  } catch {
    return null;
  }
}

/**
 * Creates a standard JSON response.
 */
function jsonResponse(statusCode: number, body: unknown): APIGatewayProxyResultV2 {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/**
 * Extracts a path parameter from the event.
 */
function getPathParam(event: APIGatewayProxyEventV2, paramName: string): string | undefined {
  return event.pathParameters?.[paramName];
}

/**
 * Maps an AIError to the appropriate HTTP response.
 * AI failures map to 503 (service unavailable) per task requirements.
 */
function mapAIErrorToResponse(error: AIError): APIGatewayProxyResultV2 {
  switch (error.kind) {
    case 'BEDROCK_INVOCATION_FAILURE':
      return jsonResponse(503, {
        error: 'AI service temporarily unavailable',
        detail: error.cause,
      });
    case 'RESPONSE_VALIDATION_FAILURE':
      return jsonResponse(503, {
        error: 'AI response could not be validated',
      });
    case 'INSUFFICIENT_CONTEXT':
      return jsonResponse(400, {
        error: 'Insufficient context for AI analysis',
        missing: error.missing,
      });
    case 'RATE_LIMITED':
      return jsonResponse(503, {
        error: 'AI service rate limited. Please retry.',
        retryAfterMs: error.retryAfterMs,
      });
    case 'TIMEOUT':
      return jsonResponse(503, {
        error: 'AI request timed out. Please retry.',
        elapsedMs: error.elapsedMs,
      });
  }
}

/**
 * Generates a sort key timestamp for message ordering.
 * Uses ISO 8601 format for lexicographic sort.
 */
function generateMessageTimestamp(): string {
  return new Date().toISOString();
}

/**
 * Builds a Message domain object from a MessageItem.
 */
function messageItemToMessage(item: MessageItem): Message {
  return {
    messageId: item.messageId as MessageId,
    threadId: item.threadId as ThreadId,
    sender: item.sender,
    content: item.content,
    structuredData: item.structuredData,
    createdAt: item.createdAt,
  };
}

/**
 * Extracts constraint keywords from message content.
 * Used to detect when new constraints arrive that should trigger table regeneration.
 */
function detectNewConstraints(content: string): string[] {
  const constraintIndicators = [
    'constraint', 'must', 'require', 'need', 'limit',
    'budget', 'deadline', 'cannot', 'should not', 'restriction',
  ];

  const lower = content.toLowerCase();
  const hasConstraintLanguage = constraintIndicators.some((indicator) =>
    lower.includes(indicator)
  );

  if (!hasConstraintLanguage) {
    return [];
  }

  // Extract sentences that contain constraint language as constraints
  const sentences = content.split(/[.!?]+/).filter((s) => s.trim().length > 0);
  return sentences
    .filter((s) => constraintIndicators.some((ind) => s.toLowerCase().includes(ind)))
    .map((s) => s.trim());
}

// =============================================================================
// Handler
// =============================================================================

/**
 * POST /threads/:id/messages — Send a message and get AI Architect response.
 *
 * Flow:
 * 1. Validate auth and request
 * 2. Persist user message (write-before-ack) — Requirement 9.2
 * 3. Fetch thread conversation history for AI context — Requirement 9.3
 * 4. Invoke appropriate AI function based on conversation state
 * 5. Persist AI response message
 * 6. Call indexEntity to keep embeddings fresh
 * 7. Return both messages
 */
async function handleSendMessage(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const authContext = extractAuthContext(event);
  if (!authContext) {
    return jsonResponse(401, { error: 'Unauthorized' });
  }

  const teamId = extractTeamId(authContext);
  if (!teamId) {
    return jsonResponse(403, { error: 'User is not assigned to any team' });
  }

  const threadId = getPathParam(event, 'threadId') as ThreadId | undefined;
  if (!threadId) {
    return jsonResponse(400, { error: 'Missing thread ID' });
  }

  // Parse request body
  let body: SendMessageRequest;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return jsonResponse(400, { error: 'Invalid JSON body' });
  }

  if (!body.content || typeof body.content !== 'string' || body.content.trim().length === 0) {
    return jsonResponse(400, { error: 'Missing or empty required field: content' });
  }

  if (!body.roomId || typeof body.roomId !== 'string') {
    return jsonResponse(400, { error: 'Missing required field: roomId' });
  }

  const roomId = body.roomId as RoomId;

  // Verify thread exists
  const threadResult = await getItem<ThreadItem>({
    pk: `ROOM#${roomId}`,
    sk: `THREAD#${threadId}`,
  });

  if (!threadResult.ok) {
    return jsonResponse(503, {
      error: 'Service temporarily unavailable',
      detail: 'Failed to verify thread existence',
    });
  }

  if (!threadResult.value) {
    return jsonResponse(404, { error: 'Thread not found' });
  }

  // =========================================================================
  // Step 1: Persist user message (write-before-acknowledge) — Requirement 9.2
  // =========================================================================

  const userMessageId = uuidv4() as string;
  const userTimestamp = generateMessageTimestamp();

  const userMessageItem: MessageItem = {
    PK: `THREAD#${threadId}`,
    SK: `MSG#${userTimestamp}#${userMessageId}`,
    entityType: 'MESSAGE',
    messageId: userMessageId,
    threadId: threadId as string,
    sender: authContext.userId,
    content: body.content.trim(),
    createdAt: userTimestamp,
  };

  const userWriteResult = await putItem({ item: userMessageItem as unknown as Record<string, unknown> });

  if (!userWriteResult.ok) {
    // Persistence failure → 503 (user message not confirmed)
    return jsonResponse(503, {
      error: 'Failed to persist message. Please retry.',
      detail: userWriteResult.error.kind === 'WRITE_FAILURE'
        ? userWriteResult.error.cause
        : 'Unknown persistence error',
    });
  }

  // =========================================================================
  // Step 2: Fetch conversation history for AI context — Requirement 9.3
  // =========================================================================

  const messagesResult = await query<MessageItem>({
    pk: `THREAD#${threadId}`,
    skPrefix: 'MSG#',
  });

  const conversationHistory: Message[] = messagesResult.ok
    ? messagesResult.value.map(messageItemToMessage)
    : [messageItemToMessage(userMessageItem)]; // Fallback: at minimum include the user's message

  // =========================================================================
  // Step 3: Determine which AI function to invoke
  // =========================================================================

  // Check if new constraints are explicitly provided or detected
  const newConstraints = body.newConstraints ?? detectNewConstraints(body.content);
  const hasNewConstraints = newConstraints.length > 0 && body.previousTable !== undefined;

  // Determine if this is the first user message (triggers sufficiency check)
  const userMessages = conversationHistory.filter((m) => m.sender !== 'ai_architect');
  const isFirstOrEarlyMessage = userMessages.length <= 2;

  // Check if AI has already proposed options in this thread
  const aiMessages = conversationHistory.filter((m) => m.sender === 'ai_architect');
  const hasProposedOptions = aiMessages.some(
    (m) => m.structuredData?.type === 'options' || m.structuredData?.type === 'tradeoff_table'
  );

  let aiContent: string;
  let aiStructuredData: MessageItem['structuredData'] | undefined;

  try {
    if (hasNewConstraints && body.previousTable) {
      // =====================================================================
      // Path A: Regenerate tradeoff table with new constraints — Req 3.4
      // =====================================================================
      const regenerateResult = await regenerateTradeoffTable({
        previousTable: body.previousTable,
        newConstraints,
        messages: conversationHistory,
      });

      if (!regenerateResult.ok) {
        return mapAIErrorToResponse(regenerateResult.error);
      }

      const { table, changes } = regenerateResult.value;
      aiContent = formatTradeoffTableResponse(table, changes);
      aiStructuredData = {
        type: 'tradeoff_table',
        payload: { table, changes },
      };
    } else if (isFirstOrEarlyMessage && !hasProposedOptions) {
      // =====================================================================
      // Path B: Assess input sufficiency for early messages — Req 4.1, 4.2
      // =====================================================================
      const sufficiencyResult = await assessInputSufficiency(conversationHistory, []);

      if (!sufficiencyResult.ok) {
        return mapAIErrorToResponse(sufficiencyResult.error);
      }

      if (!sufficiencyResult.value.sufficient) {
        // Context is insufficient — return clarifying questions
        const questions = sufficiencyResult.value.questions;
        aiContent = formatClarifyingQuestionsResponse(questions);
        aiStructuredData = {
          type: 'clarifying_questions',
          payload: questions,
        };
      } else {
        // Context is sufficient — propose options — Req 3.1, 3.2, 3.3, 3.5
        const proposalResult = await proposeOptionsWithFallback({
          messages: conversationHistory,
          constraints: extractConstraintsFromHistory(conversationHistory),
          priorDecisions: [],
        });

        if (!proposalResult.ok) {
          return mapAIErrorToResponse(proposalResult.error);
        }

        const result = proposalResult.value;
        if (result.kind === 'multiple_options') {
          aiContent = formatOptionsResponse(result.proposal.options, result.proposal.tradeoffTable);
          aiStructuredData = {
            type: 'options',
            payload: result.proposal,
          };
        } else {
          aiContent = formatSingleOptionResponse(result.option, result.relaxationSuggestions);
          aiStructuredData = {
            type: 'options',
            payload: result,
          };
        }
      }
    } else if (!hasProposedOptions) {
      // =====================================================================
      // Path C: Sufficient context accumulated — propose options
      // =====================================================================
      const proposalResult = await proposeOptionsWithFallback({
        messages: conversationHistory,
        constraints: extractConstraintsFromHistory(conversationHistory),
        priorDecisions: [],
      });

      if (!proposalResult.ok) {
        return mapAIErrorToResponse(proposalResult.error);
      }

      const result = proposalResult.value;
      if (result.kind === 'multiple_options') {
        aiContent = formatOptionsResponse(result.proposal.options, result.proposal.tradeoffTable);
        aiStructuredData = {
          type: 'options',
          payload: result.proposal,
        };
      } else {
        aiContent = formatSingleOptionResponse(result.option, result.relaxationSuggestions);
        aiStructuredData = {
          type: 'options',
          payload: result,
        };
      }
    } else {
      // =====================================================================
      // Path D: Options already proposed, new constraints detected in message
      // =====================================================================
      const detectedConstraints = detectNewConstraints(body.content);

      if (detectedConstraints.length > 0) {
        // Find the last tradeoff table from AI messages
        const lastTableMsg = [...aiMessages]
          .reverse()
          .find((m) => m.structuredData?.type === 'tradeoff_table' || m.structuredData?.type === 'options');

        const previousTable = extractTradeoffTable(lastTableMsg);

        if (previousTable) {
          const regenerateResult = await regenerateTradeoffTable({
            previousTable,
            newConstraints: detectedConstraints,
            messages: conversationHistory,
          });

          if (!regenerateResult.ok) {
            return mapAIErrorToResponse(regenerateResult.error);
          }

          const { table, changes } = regenerateResult.value;
          aiContent = formatTradeoffTableResponse(table, changes);
          aiStructuredData = {
            type: 'tradeoff_table',
            payload: { table, changes },
          };
        } else {
          // No previous table found, re-propose options with new constraints
          const proposalResult = await proposeOptionsWithFallback({
            messages: conversationHistory,
            constraints: [...extractConstraintsFromHistory(conversationHistory), ...detectedConstraints],
            priorDecisions: [],
          });

          if (!proposalResult.ok) {
            return mapAIErrorToResponse(proposalResult.error);
          }

          const result = proposalResult.value;
          if (result.kind === 'multiple_options') {
            aiContent = formatOptionsResponse(result.proposal.options, result.proposal.tradeoffTable);
            aiStructuredData = {
              type: 'options',
              payload: result.proposal,
            };
          } else {
            aiContent = formatSingleOptionResponse(result.option, result.relaxationSuggestions);
            aiStructuredData = {
              type: 'options',
              payload: result,
            };
          }
        }
      } else {
        // No new constraints — re-propose options incorporating the new message
        const proposalResult = await proposeOptionsWithFallback({
          messages: conversationHistory,
          constraints: extractConstraintsFromHistory(conversationHistory),
          priorDecisions: [],
        });

        if (!proposalResult.ok) {
          return mapAIErrorToResponse(proposalResult.error);
        }

        const result = proposalResult.value;
        if (result.kind === 'multiple_options') {
          aiContent = formatOptionsResponse(result.proposal.options, result.proposal.tradeoffTable);
          aiStructuredData = {
            type: 'options',
            payload: result.proposal,
          };
        } else {
          aiContent = formatSingleOptionResponse(result.option, result.relaxationSuggestions);
          aiStructuredData = {
            type: 'options',
            payload: result,
          };
        }
      }
    }
  } catch (error: unknown) {
    // Unexpected AI errors → 503
    const message = error instanceof Error ? error.message : 'AI processing failed';
    console.error('AI invocation error:', error);
    return jsonResponse(503, {
      error: 'AI service temporarily unavailable',
      detail: message,
    });
  }

  // =========================================================================
  // Step 4: Persist AI response message (write-before-ack)
  // =========================================================================

  const aiMessageId = uuidv4() as string;
  const aiTimestamp = generateMessageTimestamp();

  const aiMessageItem: MessageItem = {
    PK: `THREAD#${threadId}`,
    SK: `MSG#${aiTimestamp}#${aiMessageId}`,
    entityType: 'MESSAGE',
    messageId: aiMessageId,
    threadId: threadId as string,
    sender: 'ai_architect',
    content: aiContent,
    structuredData: aiStructuredData,
    createdAt: aiTimestamp,
  };

  const aiWriteResult = await putItem({ item: aiMessageItem as unknown as Record<string, unknown> });

  if (!aiWriteResult.ok) {
    // AI response persistence failure → 503
    return jsonResponse(503, {
      error: 'Failed to persist AI response. Please retry.',
      detail: aiWriteResult.error.kind === 'WRITE_FAILURE'
        ? aiWriteResult.error.cause
        : 'Unknown persistence error',
    });
  }

  // =========================================================================
  // Step 5: Index entity to keep embeddings fresh (non-blocking)
  // =========================================================================

  // Fire-and-forget: indexing failure should not block the response
  const allContent = conversationHistory
    .map((m) => m.content)
    .concat([aiContent])
    .join(' ');

  const threadTitle = threadResult.value.title;
  const summary = threadTitle.length > 200
    ? threadTitle.slice(0, 197) + '...'
    : threadTitle;

  indexEntity({
    roomId: roomId as string,
    entityId: threadId as string,
    entityType: 'THREAD',
    content: allContent,
    summary,
  }).catch((err) => {
    console.error('Failed to index entity after message update:', err);
  });

  // =========================================================================
  // Step 6: Return both messages
  // =========================================================================

  const userMessage: Message = messageItemToMessage(userMessageItem);
  const aiMessage: Message = messageItemToMessage(aiMessageItem);

  return jsonResponse(200, {
    messages: [userMessage, aiMessage],
  });
}

// =============================================================================
// Response Formatting Helpers
// =============================================================================

/**
 * Formats clarifying questions into a readable AI response.
 */
function formatClarifyingQuestionsResponse(
  questions: { question: string; relevance: string }[]
): string {
  const lines = [
    'I need a few more details to propose well-targeted architecture options:',
    '',
  ];

  questions.forEach((q, i) => {
    lines.push(`${i + 1}. **${q.question}**`);
    lines.push(`   _Why this matters: ${q.relevance}_`);
    lines.push('');
  });

  lines.push('Please answer whichever questions you can, or let me know to proceed with assumptions.');

  return lines.join('\n');
}

/**
 * Formats multiple options and a tradeoff table into a readable AI response.
 */
function formatOptionsResponse(
  options: { summary: string; benefits: string[]; risks: string[]; complexity: string }[],
  table: TradeoffTable
): string {
  const lines = [
    `I've identified ${options.length} architecture options for your consideration:`,
    '',
  ];

  options.forEach((opt, i) => {
    lines.push(`### Option ${i + 1}: ${opt.summary}`);
    lines.push(`**Complexity:** ${opt.complexity}`);
    lines.push('');
    lines.push('**Benefits:**');
    opt.benefits.forEach((b) => lines.push(`- ${b}`));
    lines.push('');
    lines.push('**Risks:**');
    opt.risks.forEach((r) => lines.push(`- ${r}`));
    lines.push('');
  });

  lines.push('### Tradeoff Comparison');
  lines.push('');
  lines.push(`| Option | ${table.constraints.join(' | ')} |`);
  lines.push(`| --- | ${table.constraints.map(() => '---').join(' | ')} |`);
  table.options.forEach((optName, i) => {
    const ratings = table.ratings[i] ?? [];
    lines.push(`| ${optName} | ${ratings.join(' | ')} |`);
  });

  return lines.join('\n');
}

/**
 * Formats a single option with relaxation suggestions.
 */
function formatSingleOptionResponse(
  option: { summary: string; benefits: string[]; risks: string[]; complexity: string },
  relaxationSuggestions: string[]
): string {
  const lines = [
    'Based on your constraints, I could only identify one viable architecture option:',
    '',
    `### ${option.summary}`,
    `**Complexity:** ${option.complexity}`,
    '',
    '**Benefits:**',
  ];

  option.benefits.forEach((b) => lines.push(`- ${b}`));
  lines.push('');
  lines.push('**Risks:**');
  option.risks.forEach((r) => lines.push(`- ${r}`));
  lines.push('');
  lines.push('### Suggestions to Enable More Options');
  lines.push('To consider additional alternatives, you could relax some constraints:');
  relaxationSuggestions.forEach((s) => lines.push(`- ${s}`));

  return lines.join('\n');
}

/**
 * Formats a regenerated tradeoff table with change tracking.
 */
function formatTradeoffTableResponse(
  table: TradeoffTable,
  changes: { optionId: string; field: string; previousValue: string; newValue: string; reason: string }[]
): string {
  const lines = [
    'I\'ve updated the tradeoff analysis with the new constraints:',
    '',
    '### Updated Tradeoff Table',
    '',
    `| Option | ${table.constraints.join(' | ')} |`,
    `| --- | ${table.constraints.map(() => '---').join(' | ')} |`,
  ];

  table.options.forEach((optName, i) => {
    const ratings = table.ratings[i] ?? [];
    lines.push(`| ${optName} | ${ratings.join(' | ')} |`);
  });

  if (changes.length > 0) {
    lines.push('');
    lines.push('### What Changed');
    changes.forEach((change) => {
      lines.push(`- **${change.optionId}** (${change.field}): ${change.previousValue} → ${change.newValue} — _${change.reason}_`);
    });
  }

  return lines.join('\n');
}

// =============================================================================
// Constraint Extraction Helpers
// =============================================================================

/**
 * Extracts constraints from the conversation history.
 * Looks for explicit constraint language in user messages.
 */
function extractConstraintsFromHistory(messages: Message[]): string[] {
  const constraints: string[] = [];

  for (const msg of messages) {
    if (msg.sender === 'ai_architect') continue;
    const detected = detectNewConstraints(msg.content);
    constraints.push(...detected);
  }

  return Array.from(new Set(constraints)); // deduplicate
}

/**
 * Extracts the tradeoff table from a previous AI message's structured data.
 */
function extractTradeoffTable(message: Message | undefined): TradeoffTable | undefined {
  if (!message?.structuredData) return undefined;

  const payload = message.structuredData.payload as Record<string, unknown>;

  if (message.structuredData.type === 'tradeoff_table') {
    return (payload as { table?: TradeoffTable }).table;
  }

  if (message.structuredData.type === 'options') {
    // Might be a ProposalResult or OptionProposal
    const asProposal = payload as { tradeoffTable?: TradeoffTable; proposal?: { tradeoffTable?: TradeoffTable } };
    return asProposal.tradeoffTable ?? asProposal.proposal?.tradeoffTable;
  }

  return undefined;
}

// =============================================================================
// Main Lambda Entry Point
// =============================================================================

/**
 * Routes incoming API Gateway events to the appropriate handler
 * based on HTTP method and path.
 */
export async function handler(event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  try {
    // POST /threads/:id/messages — Send message and get AI response
    if (method === 'POST' && /^\/threads\/[^/]+\/messages\/?$/.test(path)) {
      return await handleSendMessage(event);
    }

    return jsonResponse(404, { error: 'Not found' });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Internal server error';
    console.error('Unhandled error in AI handler:', error);
    return jsonResponse(500, { error: message });
  }
}
