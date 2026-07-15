import { z } from 'zod';
import { Result, ok, err } from '@/types/result';
import {
  Message,
  OptionProposal,
  TradeoffTable,
  ClarifyingQuestion,
  Option,
  TradeoffChange,
  ProposalResult,
} from '@/types/domain';
import { invokeClaudeModel } from '@/services/bedrock';

// =============================================================================
// Error Types
// =============================================================================

export type AIError =
  | { kind: 'BEDROCK_INVOCATION_FAILURE'; cause: string }
  | { kind: 'RESPONSE_VALIDATION_FAILURE'; rawResponse: string }
  | { kind: 'INSUFFICIENT_CONTEXT'; missing: string[] }
  | { kind: 'RATE_LIMITED'; retryAfterMs: number }
  | { kind: 'TIMEOUT'; elapsedMs: number };

// =============================================================================
// Zod Validation Schemas
// =============================================================================

const complexitySchema = z.enum(['Low', 'Medium', 'High']);

const optionSchema = z.object({
  summary: z.string().max(200).min(1),
  benefits: z.array(z.string().min(1)).min(2),
  risks: z.array(z.string().min(1)).min(2),
  complexity: complexitySchema,
});

const tradeoffTableSchema = z.object({
  options: z.array(z.string().min(1)).min(2),
  constraints: z.array(z.string().min(1)).min(1),
  ratings: z.array(z.array(z.string())),
});

const optionProposalSchema = z.object({
  options: z.array(optionSchema).min(2).max(5),
  tradeoffTable: tradeoffTableSchema,
});

const clarifyingQuestionSchema = z.object({
  question: z.string().min(1),
  relevance: z.string().min(1),
});

const clarifyingQuestionsArraySchema = z.array(clarifyingQuestionSchema).min(1).max(5);

const singleOptionResultSchema = z.object({
  option: optionSchema,
  relaxationSuggestions: z.array(z.string().min(1)).min(1),
});

const tradeoffChangeSchema = z.object({
  optionId: z.string().min(1),
  field: z.enum(['summary', 'benefits', 'risks', 'complexity', 'tradeoff_rating']),
  constraintName: z.string().optional(),
  previousValue: z.string(),
  newValue: z.string(),
  reason: z.string().min(1),
});

const regeneratedTableSchema = z.object({
  table: tradeoffTableSchema,
  changes: z.array(tradeoffChangeSchema),
});

// =============================================================================
// Trigger Criteria for Clarifying Questions
// =============================================================================

const TRIGGER_CRITERIA = [
  { key: 'scale', patterns: ['scale', 'load', 'users', 'requests per second', 'rps', 'throughput', 'traffic', 'concurrent', 'data volume', 'user count'] },
  { key: 'deployment', patterns: ['deploy', 'cloud', 'aws', 'azure', 'gcp', 'on-prem', 'on-premise', 'hybrid', 'edge', 'kubernetes', 'k8s', 'docker', 'container', 'serverless', 'lambda'] },
  { key: 'team', patterns: ['team size', 'engineers', 'developers', 'team', 'expertise', 'experience', 'staff', 'headcount'] },
  { key: 'tech_prefs', patterns: ['language', 'framework', 'stack', 'technology', 'prefer', 'existing', 'current stack', 'tech stack', 'tooling', 'library'] },
] as const;

// =============================================================================
// Helper Functions
// =============================================================================

/**
 * Extracts all user message content combined into a single string for analysis.
 */
function extractMessageContext(messages: Message[]): string {
  return messages
    .filter((m) => m.sender !== 'ai_architect')
    .map((m) => m.content)
    .join(' ')
    .toLowerCase();
}

/**
 * Determines which trigger criteria are missing from the conversation context.
 */
function findMissingCriteria(messages: Message[]): string[] {
  const context = extractMessageContext(messages);
  const missing: string[] = [];

  for (const criterion of TRIGGER_CRITERIA) {
    const found = criterion.patterns.some((pattern) => context.includes(pattern));
    if (!found) {
      missing.push(criterion.key);
    }
  }

  return missing;
}

/**
 * Maps a BedrockError to an AIError.
 */
function mapBedrockError(bedrockErr: { kind: string; statusCode?: number; message?: string; retryAfterMs?: number }): AIError {
  if (bedrockErr.kind === 'THROTTLED') {
    return { kind: 'RATE_LIMITED', retryAfterMs: bedrockErr.retryAfterMs ?? 1000 };
  }
  return {
    kind: 'BEDROCK_INVOCATION_FAILURE',
    cause: bedrockErr.message ?? bedrockErr.kind,
  };
}

/**
 * Attempts to parse a JSON string from an AI response, handling markdown code blocks.
 */
function parseJsonResponse(raw: string): unknown {
  let cleaned = raw.trim();
  // Strip markdown code fences if present
  if (cleaned.startsWith('```')) {
    const firstNewline = cleaned.indexOf('\n');
    cleaned = cleaned.slice(firstNewline + 1);
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3).trim();
    }
  }
  return JSON.parse(cleaned);
}

// =============================================================================
// System Prompts
// =============================================================================

const SUFFICIENCY_SYSTEM_PROMPT = `You are an AI architecture advisor. Given a conversation about an architecture decision, generate clarifying questions for the missing aspects of the discussion.

You MUST respond with valid JSON only — no markdown, no explanation. Return an array of objects with this structure:
[
  { "question": "the clarifying question text", "relevance": "explanation of why this matters for the architecture decision" }
]

Rules:
- Generate between 1 and 5 questions total
- Each question must be specific and actionable
- The relevance must reference a specific constraint or tradeoff the answer would clarify
- Focus on the missing criteria provided
- Reference prior ADRs by identifier if provided`;

const PROPOSE_OPTIONS_SYSTEM_PROMPT = `You are an AI architecture advisor. Based on the conversation and constraints provided, propose multiple distinct architecture options.

You MUST respond with valid JSON only — no markdown, no explanation. Return an object with this structure:
{
  "options": [
    {
      "summary": "Brief description of the option (max 200 chars)",
      "benefits": ["benefit 1", "benefit 2", ...],
      "risks": ["risk 1", "risk 2", ...],
      "complexity": "Low" | "Medium" | "High"
    }
  ],
  "tradeoffTable": {
    "options": ["Option A name", "Option B name", ...],
    "constraints": ["constraint 1", "constraint 2", ...],
    "ratings": [["rating for option A / constraint 1", ...], ...]
  }
}

Rules:
- Propose between 2 and 5 distinct options
- Each option MUST differ in at least one primary architectural approach
- Each summary MUST be ≤200 characters
- Each option MUST have at least 2 benefits and at least 2 risks
- Complexity must be exactly "Low", "Medium", or "High"
- The tradeoff table must have one row per option and one column per constraint
- Reference prior decisions by identifier when relevant
- If constraints are too restrictive for 2+ options, return exactly 1 option`;

const REGENERATE_TABLE_SYSTEM_PROMPT = `You are an AI architecture advisor. Given a previous tradeoff table and new constraints, regenerate the table and track what changed.

You MUST respond with valid JSON only — no markdown, no explanation. Return an object with this structure:
{
  "table": {
    "options": ["Option A name", ...],
    "constraints": ["constraint 1", ...],
    "ratings": [["rating", ...], ...]
  },
  "changes": [
    {
      "optionId": "option name",
      "field": "summary" | "benefits" | "risks" | "complexity" | "tradeoff_rating",
      "constraintName": "optional - for tradeoff_rating changes",
      "previousValue": "the old value",
      "newValue": "the new value",
      "reason": "why this changed"
    }
  ]
}

Rules:
- Re-evaluate all options against the combined old + new constraints
- Track every field that changed in the changes array
- For tradeoff_rating changes, include the constraintName
- Each change must include a reason explaining why the assessment changed
- The table must have one row per option and one column per constraint`;

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Evaluates whether the conversation has enough context for option proposals.
 * Checks for: scale requirements, deployment environment, team size, and technology preferences.
 * If any are missing, invokes Claude to generate targeted clarifying questions.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4
 */
export async function assessInputSufficiency(
  messages: Message[],
  priorADRs: { id: string; title: string; context: string }[]
): Promise<Result<
  | { sufficient: true }
  | { sufficient: false; questions: ClarifyingQuestion[] },
  AIError
>> {
  const missing = findMissingCriteria(messages);

  if (missing.length === 0) {
    return ok({ sufficient: true });
  }

  // Invoke Claude to generate clarifying questions for missing criteria
  const conversationSummary = messages
    .map((m) => `${m.sender}: ${m.content}`)
    .join('\n');

  const priorContext = priorADRs.length > 0
    ? `\n\nPrior ADRs in this room:\n${priorADRs.map((a) => `- ${a.id}: ${a.title} — ${a.context}`).join('\n')}`
    : '';

  const userPrompt = `The following conversation is missing details about: ${missing.join(', ')}.

Conversation so far:
${conversationSummary}
${priorContext}

Generate clarifying questions for the missing aspects. Return JSON only.`;

  const result = await invokeClaudeModel({
    systemPrompt: SUFFICIENCY_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.4,
    maxTokens: 2048,
  });

  if (!result.ok) {
    return err(mapBedrockError(result.error));
  }

  // Validate the response
  let parsed: unknown;
  try {
    parsed = parseJsonResponse(result.value);
  } catch {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  const validation = clarifyingQuestionsArraySchema.safeParse(parsed);
  if (!validation.success) {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  return ok({ sufficient: false, questions: validation.data });
}

/**
 * Invokes Bedrock Claude to propose architecture options with a tradeoff table.
 * Validates the response structure with Zod to ensure 2-5 options with required fields.
 *
 * Requirements: 3.1, 3.2, 3.3
 */
export async function proposeOptions(params: {
  messages: Message[];
  constraints: string[];
  priorDecisions: { id: string; title: string; relevance: string }[];
}): Promise<Result<OptionProposal, AIError>> {
  const { messages, constraints, priorDecisions } = params;

  const conversationSummary = messages
    .map((m) => `${m.sender}: ${m.content}`)
    .join('\n');

  const constraintsList = constraints.length > 0
    ? `\n\nStated constraints:\n${constraints.map((c) => `- ${c}`).join('\n')}`
    : '';

  const priorContext = priorDecisions.length > 0
    ? `\n\nPrior decisions to reference:\n${priorDecisions.map((d) => `- ${d.id}: ${d.title} (${d.relevance})`).join('\n')}`
    : '';

  const userPrompt = `Based on the following conversation, propose architecture options.

Conversation:
${conversationSummary}
${constraintsList}
${priorContext}

Return JSON only.`;

  const result = await invokeClaudeModel({
    systemPrompt: PROPOSE_OPTIONS_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.7,
    maxTokens: 4096,
  });

  if (!result.ok) {
    return err(mapBedrockError(result.error));
  }

  let parsed: unknown;
  try {
    parsed = parseJsonResponse(result.value);
  } catch {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  const validation = optionProposalSchema.safeParse(parsed);
  if (!validation.success) {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  return ok(validation.data);
}

/**
 * Wraps `proposeOptions` with a fallback to a single-option result when constraints
 * are too restrictive for 2+ distinct options. Returns a discriminated union
 * indicating whether multiple options or a single option with relaxation suggestions
 * was produced.
 *
 * Requirements: 3.5
 */
export async function proposeOptionsWithFallback(params: {
  messages: Message[];
  constraints: string[];
  priorDecisions: { id: string; title: string; relevance: string }[];
}): Promise<Result<ProposalResult, AIError>> {
  const proposalResult = await proposeOptions(params);

  // If proposal succeeded with 2+ options, return as multiple_options
  if (proposalResult.ok) {
    return ok({ kind: 'multiple_options', proposal: proposalResult.value });
  }

  // If the error was a validation failure, it might be because only 1 option was returned
  if (proposalResult.error.kind === 'RESPONSE_VALIDATION_FAILURE') {
    // Attempt to parse as a single-option result
    let parsed: unknown;
    try {
      parsed = parseJsonResponse(proposalResult.error.rawResponse);
    } catch {
      return err(proposalResult.error);
    }

    // Check if it's a proposal with only 1 option (constraint too restrictive)
    const asProposal = parsed as { options?: unknown[] };
    if (asProposal && Array.isArray(asProposal.options) && asProposal.options.length === 1) {
      const singleOptionValidation = optionSchema.safeParse(asProposal.options[0]);
      if (singleOptionValidation.success) {
        // Generate relaxation suggestions
        const relaxationResult = await generateRelaxationSuggestions(params);
        return ok({
          kind: 'single_option',
          option: singleOptionValidation.data,
          relaxationSuggestions: relaxationResult,
        });
      }
    }

    // Try parsing as explicit single-option format
    const singleValidation = singleOptionResultSchema.safeParse(parsed);
    if (singleValidation.success) {
      return ok({
        kind: 'single_option',
        option: singleValidation.data.option,
        relaxationSuggestions: singleValidation.data.relaxationSuggestions,
      });
    }

    return err(proposalResult.error);
  }

  return err(proposalResult.error);
}

/**
 * Re-evaluates options against new constraints and tracks what changed compared
 * to the previous table. Returns an updated TradeoffTable and a TradeoffChange[]
 * documenting each modification.
 *
 * Requirements: 3.4
 */
export async function regenerateTradeoffTable(params: {
  previousTable: TradeoffTable;
  newConstraints: string[];
  messages: Message[];
}): Promise<Result<{ table: TradeoffTable; changes: TradeoffChange[] }, AIError>> {
  const { previousTable, newConstraints, messages } = params;

  const conversationSummary = messages
    .map((m) => `${m.sender}: ${m.content}`)
    .join('\n');

  const userPrompt = `Regenerate the tradeoff table with new constraints added.

Previous table:
${JSON.stringify(previousTable, null, 2)}

New constraints to add: ${newConstraints.join(', ')}

Conversation context:
${conversationSummary}

Re-evaluate all options and track every change. Return JSON only.`;

  const result = await invokeClaudeModel({
    systemPrompt: REGENERATE_TABLE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.5,
    maxTokens: 4096,
  });

  if (!result.ok) {
    return err(mapBedrockError(result.error));
  }

  let parsed: unknown;
  try {
    parsed = parseJsonResponse(result.value);
  } catch {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  const validation = regeneratedTableSchema.safeParse(parsed);
  if (!validation.success) {
    return err({ kind: 'RESPONSE_VALIDATION_FAILURE', rawResponse: result.value });
  }

  return ok({
    table: validation.data.table,
    changes: validation.data.changes,
  });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Generates relaxation suggestions when constraints are too restrictive.
 */
async function generateRelaxationSuggestions(params: {
  messages: Message[];
  constraints: string[];
  priorDecisions: { id: string; title: string; relevance: string }[];
}): Promise<string[]> {
  const { constraints } = params;

  const userPrompt = `The following constraints are too restrictive to produce 2+ distinct architecture options:
${constraints.map((c) => `- ${c}`).join('\n')}

Suggest which constraints could be relaxed or adjusted to enable more alternatives. Return a JSON array of suggestion strings.`;

  const result = await invokeClaudeModel({
    systemPrompt: 'You are an AI architecture advisor. Return only a JSON array of strings — no markdown, no explanation.',
    messages: [{ role: 'user', content: userPrompt }],
    temperature: 0.4,
    maxTokens: 1024,
  });

  if (!result.ok) {
    // Fallback: return generic suggestions based on constraint count
    return constraints.map((c) => `Consider relaxing: "${c}"`);
  }

  try {
    const parsed = parseJsonResponse(result.value);
    const validated = z.array(z.string().min(1)).min(1).safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }
  } catch {
    // Fall through to generic suggestions
  }

  return constraints.map((c) => `Consider relaxing: "${c}"`);
}
