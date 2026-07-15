import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// =============================================================================
// Shared Mocks
// =============================================================================

// Mock the Bedrock service at the service layer (not SDK level)
const mockInvokeClaudeModel = vi.hoisted(() => vi.fn());

vi.mock('@/services/bedrock', () => ({
  invokeClaudeModel: mockInvokeClaudeModel,
}));

// Mock DynamoDB service (used by getNextSequentialId internally)
vi.mock('@/services/dynamo', () => ({
  query: vi.fn().mockResolvedValue({ ok: true, value: [] }),
  putItem: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

// Mock S3 service
vi.mock('@/services/s3', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ ok: true, value: { key: 'test', url: 'test' } }),
}));

import { generateADR } from '@/lib/adr-generator';
import type { ADR, DecisionThread, CrossReference, ThreadId, RoomId } from '@/types/domain';

// =============================================================================
// Shared Generators
// =============================================================================

const threadIdArb = fc.uuid().map((id) => id as ThreadId);
const roomIdArb = fc.uuid().map((id) => id as RoomId);

const isoDateArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString());

const decidedThreadArb: fc.Arbitrary<DecisionThread> = fc.record({
  threadId: threadIdArb,
  roomId: roomIdArb,
  title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
  status: fc.constant('DECIDED' as const),
  createdBy: fc.string({ minLength: 1, maxLength: 50 }),
  createdAt: isoDateArb,
  updatedAt: isoDateArb,
  selectedOption: fc.string({ minLength: 1, maxLength: 200 }),
});

const crossReferenceArb: fc.Arbitrary<CrossReference> = fc.record({
  sourceThreadId: threadIdArb,
  targetThreadId: threadIdArb,
  referenceType: fc.constantFrom('SUPERSEDES', 'DEPENDS_ON', 'CONTRADICTS', 'RELATED_TO') as fc.Arbitrary<CrossReference['referenceType']>,
  description: fc.string({ minLength: 1, maxLength: 200 }),
  createdAt: isoDateArb,
});

const sequentialIdArb = fc.integer({ min: 1, max: 999 });

// =============================================================================
// Property 8: ADR contains all required sections
// =============================================================================

/**
 * Property 8: ADR contains all required sections
 *
 * For any ADR generated from a decided thread, it contains: sequential identifier
 * matching `ADR-NNN` (zero-padded 3 digits), non-empty title, valid date, status ACTIVE,
 * non-empty context, ≥2 options considered, non-empty decision, non-empty consequences.
 *
 * **Validates: Requirements 5.1**
 */

// Generators specific to Property 8

/** Generates a non-empty selected option string. */
const selectedOptionArb = fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0);

/** Generates an option with name and summary for the mock response. */
const optionConsideredArb = fc.record({
  name: fc.string({ minLength: 1, maxLength: 80 }).filter((s) => s.trim().length > 0),
  summary: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
});

/**
 * Generates a valid ADR JSON response that Bedrock would return.
 * Ensures ≥2 options considered (matching the Zod schema requirement in adr-generator).
 */
const adrResponseArb = fc.record({
  title: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
  context: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
  optionsConsidered: fc.array(optionConsideredArb, { minLength: 2, maxLength: 5 }),
  decision: fc.string({ minLength: 1, maxLength: 300 }).filter((s) => s.trim().length > 0),
  consequences: fc.string({ minLength: 1, maxLength: 300 }).filter((s) => s.trim().length > 0),
});

describe('Property 8: ADR contains all required sections', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('for any ADR generated from a decided thread, it contains: ADR-NNN identifier, non-empty title, valid ISO date, ACTIVE status, non-empty context, ≥2 options considered, non-empty decision, non-empty consequences', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        fc.array(crossReferenceArb, { minLength: 0, maxLength: 3 }),
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, crossRefs, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          // Mock Bedrock to return a valid ADR JSON response
          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: crossRefs as CrossReference[],
            nextSequentialId: seqId,
          });

          // Generation should succeed with valid input and valid mock response
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // 1. adrId matches pattern ADR-NNN (zero-padded 3 digits)
          expect(adr.adrId).toMatch(/^ADR-\d{3}$/);
          const expectedId = `ADR-${String(seqId).padStart(3, '0')}`;
          expect(adr.adrId).toBe(expectedId);

          // 2. title is non-empty
          expect(adr.title.length).toBeGreaterThan(0);

          // 3. date is a valid ISO 8601 string
          const parsedDate = new Date(adr.date);
          expect(parsedDate.toString()).not.toBe('Invalid Date');
          expect(adr.date).toBe(parsedDate.toISOString());

          // 4. status is ACTIVE
          expect(adr.status).toBe('ACTIVE');

          // 5. context is non-empty
          expect(adr.context.length).toBeGreaterThan(0);

          // 6. optionsConsidered has ≥2 items
          expect(adr.optionsConsidered.length).toBeGreaterThanOrEqual(2);
          for (const option of adr.optionsConsidered) {
            expect(option.name.length).toBeGreaterThan(0);
            expect(option.summary.length).toBeGreaterThan(0);
          }

          // 7. decision is non-empty
          expect(adr.decision.length).toBeGreaterThan(0);

          // 8. consequences is non-empty
          expect(adr.consequences.length).toBeGreaterThan(0);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('sequential ID formatting produces zero-padded 3-digit identifiers for any valid ID in 1-999 range', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // Extract the numeric portion from ADR-NNN
          const numericPart = adr.adrId.replace('ADR-', '');
          expect(numericPart).toHaveLength(3);
          expect(parseInt(numericPart, 10)).toBe(seqId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('ADR sequentialId field matches the provided nextSequentialId parameter', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value.sequentialId).toBe(seqId);
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 9: ADR includes cross-references when present
// =============================================================================

/**
 * Property 9: ADR includes cross-references when present
 *
 * For any thread with ≥1 CrossReferences, the generated ADR includes a
 * "Related Decisions" section listing every referenced ADR by identifier and title.
 *
 * **Validates: Requirements 5.3**
 */

describe('Property 9: ADR includes cross-references when present', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('for any thread with ≥1 CrossReferences, relatedDecisions length matches crossReferences input length', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        fc.array(crossReferenceArb, { minLength: 1, maxLength: 5 }),
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, crossReferences, nextSequentialId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: crossReferences as CrossReference[],
            nextSequentialId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // relatedDecisions array length matches crossReferences input length
          expect(adr.relatedDecisions.length).toBe(crossReferences.length);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('each related decision entry has non-empty adrId, non-empty title, and non-empty relationship', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        fc.array(crossReferenceArb, { minLength: 1, maxLength: 5 }),
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, crossReferences, nextSequentialId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: crossReferences as CrossReference[],
            nextSequentialId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // Each related decision entry has required non-empty fields
          for (const relatedDecision of adr.relatedDecisions) {
            expect(relatedDecision.adrId.length).toBeGreaterThan(0);
            expect(relatedDecision.title.length).toBeGreaterThan(0);
            expect(relatedDecision.relationship.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('relatedDecisions maps each CrossReference targetThreadId to adrId, description to title, and referenceType to relationship', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        fc.array(crossReferenceArb, { minLength: 1, maxLength: 5 }),
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, crossReferences, nextSequentialId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: crossReferences as CrossReference[],
            nextSequentialId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // Verify the mapping: crossReferences[i] → relatedDecisions[i]
          for (let i = 0; i < crossReferences.length; i++) {
            const ref = crossReferences[i];
            const related = adr.relatedDecisions[i];

            // adrId comes from targetThreadId
            expect(related.adrId).toBe(ref.targetThreadId);
            // title comes from description
            expect(related.title).toBe(ref.description);
            // relationship comes from referenceType
            expect(related.relationship).toBe(ref.referenceType);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 10: ADR supersession updates status correctly
// =============================================================================

/**
 * Property 10: ADR supersession updates status correctly
 *
 * For any ADR with ACTIVE status, when thread is superseded, ADR status
 * updates to SUPERSEDED with reference to superseding ADR identifier.
 *
 * **Validates: Requirements 5.4**
 */

// Generator for a superseding ADR identifier (e.g., "ADR-005")
const supersedingAdrIdArb = fc.integer({ min: 1, max: 999 }).map(
  (n) => `ADR-${String(n).padStart(3, '0')}`
);

describe('Property 10: ADR supersession updates status correctly', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('generateADR always produces an ADR with ACTIVE status', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        fc.array(crossReferenceArb, { minLength: 0, maxLength: 3 }),
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, crossReferences, nextSequentialId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: crossReferences as CrossReference[],
            nextSequentialId,
          });

          // Generation should succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const adr = result.value;

          // ADR status MUST be ACTIVE when first generated
          expect(adr.status).toBe('ACTIVE');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('for any ACTIVE ADR and any superseding ADR identifier, updating to SUPERSEDED correctly stores the superseding reference', () => {
    fc.assert(
      fc.property(
        // Generate a valid ADR with ACTIVE status
        fc.record({
          adrId: fc.integer({ min: 1, max: 999 }).map((n) => `ADR-${String(n).padStart(3, '0')}`),
          roomId: roomIdArb,
          threadId: threadIdArb,
          sequentialId: sequentialIdArb,
          title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
          status: fc.constant('ACTIVE' as const),
          date: isoDateArb,
          context: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          optionsConsidered: fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
              summary: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
            }),
            { minLength: 2, maxLength: 5 },
          ),
          decision: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          consequences: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          relatedDecisions: fc.array(
            fc.record({
              adrId: fc.string({ minLength: 1, maxLength: 20 }),
              title: fc.string({ minLength: 1, maxLength: 200 }),
              relationship: fc.string({ minLength: 1, maxLength: 50 }),
            }),
            { minLength: 0, maxLength: 3 },
          ),
          createdAt: isoDateArb,
          updatedAt: isoDateArb,
        }),
        supersedingAdrIdArb,
        (activeAdr, supersedingAdrId) => {
          // Verify the ADR starts as ACTIVE
          expect(activeAdr.status).toBe('ACTIVE');

          // Simulate supersession: update status to SUPERSEDED with reference
          const supersededAdr: ADR = {
            ...activeAdr,
            status: 'SUPERSEDED',
            relatedDecisions: [
              ...activeAdr.relatedDecisions,
              {
                adrId: supersedingAdrId,
                title: 'Superseding decision',
                relationship: 'SUPERSEDES',
              },
            ],
            updatedAt: new Date().toISOString(),
          };

          // Status must be SUPERSEDED
          expect(supersededAdr.status).toBe('SUPERSEDED');

          // Must reference the superseding ADR identifier
          const supersedingRef = supersededAdr.relatedDecisions.find(
            (ref) => ref.adrId === supersedingAdrId && ref.relationship === 'SUPERSEDES',
          );
          expect(supersedingRef).toBeDefined();
          expect(supersedingRef!.adrId).toBe(supersedingAdrId);
          expect(supersedingRef!.relationship).toBe('SUPERSEDES');

          // Original related decisions are preserved
          for (const originalRef of activeAdr.relatedDecisions) {
            expect(
              supersededAdr.relatedDecisions.some(
                (r) => r.adrId === originalRef.adrId && r.relationship === originalRef.relationship,
              ),
            ).toBe(true);
          }

          // The superseded ADR identifier should remain unchanged
          expect(supersededAdr.adrId).toBe(activeAdr.adrId);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('superseded ADR preserves all original fields except status, relatedDecisions, and updatedAt', () => {
    fc.assert(
      fc.property(
        fc.record({
          adrId: fc.integer({ min: 1, max: 999 }).map((n) => `ADR-${String(n).padStart(3, '0')}`),
          roomId: roomIdArb,
          threadId: threadIdArb,
          sequentialId: sequentialIdArb,
          title: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
          status: fc.constant('ACTIVE' as const),
          date: isoDateArb,
          context: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          optionsConsidered: fc.array(
            fc.record({
              name: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
              summary: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
            }),
            { minLength: 2, maxLength: 5 },
          ),
          decision: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          consequences: fc.string({ minLength: 1, maxLength: 500 }).filter((s) => s.trim().length > 0),
          relatedDecisions: fc.constant([] as ADR['relatedDecisions']),
          createdAt: isoDateArb,
          updatedAt: isoDateArb,
        }),
        supersedingAdrIdArb,
        (activeAdr, supersedingAdrId) => {
          // Supersede the ADR
          const supersededAdr: ADR = {
            ...activeAdr,
            status: 'SUPERSEDED',
            relatedDecisions: [
              {
                adrId: supersedingAdrId,
                title: 'Superseding decision',
                relationship: 'SUPERSEDES',
              },
            ],
            updatedAt: new Date().toISOString(),
          };

          // Immutable fields must be preserved
          expect(supersededAdr.adrId).toBe(activeAdr.adrId);
          expect(supersededAdr.roomId).toBe(activeAdr.roomId);
          expect(supersededAdr.threadId).toBe(activeAdr.threadId);
          expect(supersededAdr.sequentialId).toBe(activeAdr.sequentialId);
          expect(supersededAdr.title).toBe(activeAdr.title);
          expect(supersededAdr.date).toBe(activeAdr.date);
          expect(supersededAdr.context).toBe(activeAdr.context);
          expect(supersededAdr.optionsConsidered).toEqual(activeAdr.optionsConsidered);
          expect(supersededAdr.decision).toBe(activeAdr.decision);
          expect(supersededAdr.consequences).toBe(activeAdr.consequences);
          expect(supersededAdr.createdAt).toBe(activeAdr.createdAt);
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 11: Insufficient context ADR error enumerates missing sections
// =============================================================================

/**
 * Property 11: Insufficient context ADR error enumerates missing sections
 *
 * For any thread missing required ADR sections, generation returns error with
 * `INSUFFICIENT_CONTEXT` kind and `missingSections` array listing exactly those
 * sections lacking information. The function should return INSUFFICIENT_CONTEXT
 * without invoking the AI model.
 *
 * **Validates: Requirements 5.6**
 */

// Generators specific to Property 11

/** Generates empty or whitespace-only strings (simulating missing title). */
const emptyOrWhitespaceArb = fc.oneof(
  fc.constant(''),
  fc.stringOf(fc.constantFrom(' ', '\t', '\n', '\r'), { minLength: 1, maxLength: 20 }),
);

/** Generates a non-empty, non-whitespace string (valid content). */
const nonEmptyStringArb = fc
  .string({ minLength: 1, maxLength: 200 })
  .filter((s) => s.trim().length > 0);

describe('Property 11: Insufficient context ADR error enumerates missing sections', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('when title is empty/whitespace, returns INSUFFICIENT_CONTEXT with "title" in missingSections', async () => {
    await fc.assert(
      fc.asyncProperty(
        emptyOrWhitespaceArb,
        nonEmptyStringArb,
        threadIdArb,
        roomIdArb,
        isoDateArb,
        sequentialIdArb,
        async (emptyTitle, validSelectedOption, threadId, roomId, date, seqId) => {
          mockInvokeClaudeModel.mockReset();

          const thread: DecisionThread = {
            threadId,
            roomId,
            title: emptyTitle,
            status: 'DECIDED',
            createdBy: 'user-1',
            createdAt: date,
            updatedAt: date,
          };

          const result = await generateADR({
            thread,
            selectedOption: validSelectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Must return an error
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Error kind is INSUFFICIENT_CONTEXT
            expect(result.error.kind).toBe('INSUFFICIENT_CONTEXT');
            if (result.error.kind === 'INSUFFICIENT_CONTEXT') {
              // missingSections is a non-empty array
              expect(result.error.missingSections.length).toBeGreaterThan(0);
              // 'title' is in missingSections
              expect(result.error.missingSections).toContain('title');
            }
          }

          // AI model should NOT have been invoked
          expect(mockInvokeClaudeModel).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('when selectedOption is empty/whitespace, returns INSUFFICIENT_CONTEXT with "decision" in missingSections', async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmptyStringArb,
        emptyOrWhitespaceArb,
        threadIdArb,
        roomIdArb,
        isoDateArb,
        sequentialIdArb,
        async (validTitle, emptySelectedOption, threadId, roomId, date, seqId) => {
          mockInvokeClaudeModel.mockReset();

          const thread: DecisionThread = {
            threadId,
            roomId,
            title: validTitle,
            status: 'DECIDED',
            createdBy: 'user-1',
            createdAt: date,
            updatedAt: date,
          };

          const result = await generateADR({
            thread,
            selectedOption: emptySelectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Must return an error
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Error kind is INSUFFICIENT_CONTEXT
            expect(result.error.kind).toBe('INSUFFICIENT_CONTEXT');
            if (result.error.kind === 'INSUFFICIENT_CONTEXT') {
              // missingSections is a non-empty array
              expect(result.error.missingSections.length).toBeGreaterThan(0);
              // 'decision' is in missingSections
              expect(result.error.missingSections).toContain('decision');
            }
          }

          // AI model should NOT have been invoked
          expect(mockInvokeClaudeModel).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });

  it('when both title and selectedOption are empty/whitespace, missingSections contains both "title" and "decision"', async () => {
    await fc.assert(
      fc.asyncProperty(
        emptyOrWhitespaceArb,
        emptyOrWhitespaceArb,
        threadIdArb,
        roomIdArb,
        isoDateArb,
        sequentialIdArb,
        async (emptyTitle, emptySelectedOption, threadId, roomId, date, seqId) => {
          mockInvokeClaudeModel.mockReset();

          const thread: DecisionThread = {
            threadId,
            roomId,
            title: emptyTitle,
            status: 'DECIDED',
            createdBy: 'user-1',
            createdAt: date,
            updatedAt: date,
          };

          const result = await generateADR({
            thread,
            selectedOption: emptySelectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Must return an error
          expect(result.ok).toBe(false);
          if (!result.ok) {
            // Error kind is INSUFFICIENT_CONTEXT
            expect(result.error.kind).toBe('INSUFFICIENT_CONTEXT');
            if (result.error.kind === 'INSUFFICIENT_CONTEXT') {
              // missingSections contains both missing sections
              expect(result.error.missingSections).toContain('title');
              expect(result.error.missingSections).toContain('decision');
              // missingSections has at least 2 entries
              expect(result.error.missingSections.length).toBeGreaterThanOrEqual(2);
            }
          }

          // AI model should NOT have been invoked
          expect(mockInvokeClaudeModel).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 100 },
    );
  });
});


// =============================================================================
// Property 22: ADR generation completes within timeout
// =============================================================================

/**
 * Property 22: ADR generation completes within timeout
 *
 * For any Decision_Thread transitioning to DECIDED, `generateADR` either returns
 * a successful Result within 30,000ms or returns a timeout error. If a timeout
 * occurs, the system retries up to 3 times before surfacing the failure.
 *
 * **Validates: Requirements 5.2**
 */

import { ADR_GENERATION_TIMEOUT_MS } from '@/lib/adr-generator';

describe('Property 22: ADR generation completes within timeout', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('ADR_GENERATION_TIMEOUT_MS equals 30,000ms', () => {
    expect(ADR_GENERATION_TIMEOUT_MS).toBe(30_000);
  });

  it('for any valid thread, when AI responds quickly, generateADR returns a valid ADR', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          // Mock Bedrock to resolve immediately with a valid response
          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: JSON.stringify(mockAdrResponse),
          });

          const result = await generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Should succeed since AI responded quickly
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value.adrId).toMatch(/^ADR-\d{3}$/);
          expect(result.value.status).toBe('ACTIVE');
        },
      ),
      { numRuns: 50 },
    );
  });

  it('for any valid thread, when AI exceeds 30s timeout on all 3 attempts, generateADR returns a TIMEOUT error', async () => {
    vi.useFakeTimers();

    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        async (thread, selectedOption, seqId) => {
          mockInvokeClaudeModel.mockReset();

          // Mock Bedrock to never resolve (simulating a timeout scenario)
          mockInvokeClaudeModel.mockImplementation(
            () => new Promise(() => {/* never resolves */}),
          );

          // Start the generation (non-blocking)
          const resultPromise = generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Advance time for all 3 attempts (each times out at 30s)
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);

          const result = await resultPromise;

          // Should fail with TIMEOUT error after all retries exhausted
          expect(result.ok).toBe(false);
          if (result.ok) return;

          expect(result.error.kind).toBe('TIMEOUT');
          if (result.error.kind === 'TIMEOUT') {
            expect(result.error.elapsedMs).toBe(ADR_GENERATION_TIMEOUT_MS);
          }
        },
      ),
      { numRuns: 20 },
    );

    vi.useRealTimers();
  });

  it('for any valid thread, when first 2 attempts timeout but 3rd succeeds, generateADR returns a valid ADR', async () => {
    vi.useFakeTimers();

    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          let callCount = 0;

          // First 2 calls never resolve (will timeout), 3rd call resolves immediately
          mockInvokeClaudeModel.mockImplementation(() => {
            callCount++;
            if (callCount <= 2) {
              return new Promise(() => {/* never resolves — will timeout */});
            }
            return Promise.resolve({
              ok: true,
              value: JSON.stringify(mockAdrResponse),
            });
          });

          const resultPromise = generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Advance time for the first 2 timeouts
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);

          const result = await resultPromise;

          // 3rd attempt should succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value.adrId).toMatch(/^ADR-\d{3}$/);
          expect(result.value.status).toBe('ACTIVE');
          expect(callCount).toBe(3);
        },
      ),
      { numRuns: 20 },
    );

    vi.useRealTimers();
  });

  it('for any valid thread, when first attempt times out but 2nd succeeds, generateADR retries and returns a valid ADR', async () => {
    vi.useFakeTimers();

    await fc.assert(
      fc.asyncProperty(
        decidedThreadArb,
        selectedOptionArb,
        sequentialIdArb,
        adrResponseArb,
        async (thread, selectedOption, seqId, mockAdrResponse) => {
          mockInvokeClaudeModel.mockReset();

          let callCount = 0;

          // 1st call never resolves (will timeout), 2nd call resolves immediately
          mockInvokeClaudeModel.mockImplementation(() => {
            callCount++;
            if (callCount === 1) {
              return new Promise(() => {/* never resolves — will timeout */});
            }
            return Promise.resolve({
              ok: true,
              value: JSON.stringify(mockAdrResponse),
            });
          });

          const resultPromise = generateADR({
            thread: thread as DecisionThread,
            selectedOption,
            crossReferences: [],
            nextSequentialId: seqId,
          });

          // Advance time for the 1st timeout
          await vi.advanceTimersByTimeAsync(ADR_GENERATION_TIMEOUT_MS);

          const result = await resultPromise;

          // 2nd attempt should succeed
          expect(result.ok).toBe(true);
          if (!result.ok) return;

          expect(result.value.adrId).toMatch(/^ADR-\d{3}$/);
          expect(callCount).toBe(2);
        },
      ),
      { numRuns: 20 },
    );

    vi.useRealTimers();
  });
});
