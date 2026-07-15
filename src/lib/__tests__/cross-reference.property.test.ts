import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// =============================================================================
// Shared Mocks
// =============================================================================

const mockQuery = vi.hoisted(() => vi.fn());

vi.mock('@/services/dynamo', () => ({
  query: mockQuery,
  putItem: vi.fn().mockResolvedValue({ ok: true, value: {} }),
}));

import { summarizeChangesSince } from '@/lib/cross-reference';
import type {
  RoomId,
  ThreadId,
  ThreadStatus,
  ReferenceType,
  ADRItem,
  ThreadItem,
  CrossReferenceItem,
} from '@/types/domain';

// =============================================================================
// Shared Generators
// =============================================================================

const roomIdArb = fc.uuid().map((id) => id as RoomId);
const threadIdArb = fc.uuid().map((id) => id as ThreadId);

const isoDateArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString());

const threadStatusArb: fc.Arbitrary<ThreadStatus> = fc.constantFrom(
  'DRAFT',
  'IN_PROGRESS',
  'DECIDED',
  'SUPERSEDED',
);

const referenceTypeArb: fc.Arbitrary<ReferenceType> = fc.constantFrom(
  'SUPERSEDES',
  'DEPENDS_ON',
  'CONTRADICTS',
  'RELATED_TO',
);

/**
 * Generates an ADRItem with a controlled createdAt date.
 */
const adrItemArb = (roomId: string): fc.Arbitrary<ADRItem> =>
  fc.record({
    PK: fc.constant(`ROOM#${roomId}` as ADRItem['PK']),
    SK: fc.uuid().map((id) => `ADR#${id}` as ADRItem['SK']),
    GSI3PK: fc.constant(`ROOM#${roomId}` as ADRItem['GSI3PK']),
    GSI3SK: fc.integer({ min: 1, max: 999 }).map(
      (n) => `ADR_SEQ#${String(n).padStart(3, '0')}` as ADRItem['GSI3SK'],
    ),
    entityType: fc.constant('ADR' as const),
    adrId: fc.uuid(),
    roomId: fc.constant(roomId),
    threadId: fc.uuid(),
    sequentialId: fc.integer({ min: 1, max: 999 }),
    title: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    status: fc.constant('ACTIVE' as const),
    date: isoDateArb,
    context: fc.string({ minLength: 1, maxLength: 200 }),
    optionsConsidered: fc.array(
      fc.record({
        name: fc.string({ minLength: 1, maxLength: 50 }),
        summary: fc.string({ minLength: 1, maxLength: 100 }),
      }),
      { minLength: 1, maxLength: 3 },
    ),
    decision: fc.string({ minLength: 1, maxLength: 200 }),
    consequences: fc.string({ minLength: 1, maxLength: 200 }),
    relatedDecisions: fc.constant([]),
    createdAt: isoDateArb,
    updatedAt: isoDateArb,
  });

/**
 * Generates a ThreadItem with a controlled status and updatedAt.
 */
const threadItemArb = (roomId: string): fc.Arbitrary<ThreadItem> =>
  fc.record({
    PK: fc.constant(`ROOM#${roomId}` as ThreadItem['PK']),
    SK: fc.uuid().map((id) => `THREAD#${id}` as ThreadItem['SK']),
    GSI1PK: fc.constant(`ROOM#${roomId}` as ThreadItem['GSI1PK']),
    GSI1SK: fc
      .tuple(threadStatusArb, isoDateArb)
      .map(([s, d]) => `STATUS#${s}#DATE#${d}` as ThreadItem['GSI1SK']),
    entityType: fc.constant('THREAD' as const),
    threadId: fc.uuid(),
    roomId: fc.constant(roomId),
    title: fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    status: threadStatusArb,
    createdBy: fc.string({ minLength: 1, maxLength: 50 }),
    createdAt: isoDateArb,
    updatedAt: isoDateArb,
    supersededBy: fc.option(fc.uuid(), { nil: undefined }),
  });

// =============================================================================
// Property 26: Room change summary completeness
// =============================================================================

/**
 * Property 26: Room change summary completeness
 *
 * For any room and date D, `summarizeChangesSince` returns all ADRs created
 * after D, all threads referencing the focus thread, and all superseded threads;
 * `totalChanges` equals the sum of all arrays' lengths.
 *
 * **Validates: Requirements 6.4**
 */

describe('Property 26: Room change summary completeness', () => {
  beforeEach(() => {
    mockQuery.mockReset();
  });

  it('newADRs only contains ADRs with createdAt > sinceDate', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        threadIdArb,
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.array(isoDateArb, { minLength: 1, maxLength: 10 }),
        async (roomId, focusThreadId, sinceDate, adrDates) => {
          mockQuery.mockReset();

          const sinceDateISO = sinceDate.toISOString();

          // Create ADR items with various createdAt dates
          const adrItems: ADRItem[] = adrDates.map((createdAt, i) => ({
            PK: `ROOM#${roomId}` as ADRItem['PK'],
            SK: `ADR#adr-${i}` as ADRItem['SK'],
            GSI3PK: `ROOM#${roomId}` as ADRItem['GSI3PK'],
            GSI3SK: `ADR_SEQ#${String(i + 1).padStart(3, '0')}` as ADRItem['GSI3SK'],
            entityType: 'ADR' as const,
            adrId: `adr-${i}`,
            roomId: roomId as string,
            threadId: `thread-${i}`,
            sequentialId: i + 1,
            title: `ADR Title ${i}`,
            status: 'ACTIVE' as const,
            date: createdAt,
            context: 'context',
            optionsConsidered: [{ name: 'opt', summary: 'sum' }],
            decision: 'decision',
            consequences: 'consequences',
            relatedDecisions: [],
            createdAt,
            updatedAt: createdAt,
          }));

          // Mock query calls:
          // 1st call: ADRs in room (pk=ROOM#roomId, skPrefix=ADR#)
          // 2nd call: threads in room for focus thread references (pk=ROOM#roomId, skPrefix=THREAD#)
          // 3rd+ calls: cross-reference lookups per thread
          // Last call: threads for superseded check (pk=ROOM#roomId, skPrefix=THREAD#)
          mockQuery.mockImplementation(async (params: { pk: string; skPrefix?: string }) => {
            if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'ADR#') {
              return { ok: true, value: adrItems };
            }
            if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'THREAD#') {
              return { ok: true, value: [] }; // No threads for simplicity
            }
            return { ok: true, value: [] };
          });

          const result = await summarizeChangesSince({
            roomId,
            sinceDate,
            focusThreadId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const summary = result.value;

          // Verify: newADRs only contains ADRs with createdAt > sinceDate
          const expectedNewADRs = adrItems.filter((adr) => adr.createdAt > sinceDateISO);

          expect(summary.newADRs.length).toBe(expectedNewADRs.length);

          for (const newAdr of summary.newADRs) {
            const originalAdr = adrItems.find((a) => a.adrId === newAdr.adrId);
            expect(originalAdr).toBeDefined();
            expect(originalAdr!.createdAt > sinceDateISO).toBe(true);
          }

          // Verify no ADRs before sinceDate are included
          for (const adr of adrItems) {
            if (adr.createdAt <= sinceDateISO) {
              expect(summary.newADRs.find((a) => a.adrId === adr.adrId)).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('supersededThreads only contains threads with status SUPERSEDED and updatedAt > sinceDate', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.array(
          fc.record({
            status: threadStatusArb,
            updatedAt: isoDateArb,
            threadId: fc.uuid(),
            title: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
            supersededBy: fc.option(fc.uuid(), { nil: undefined }),
          }),
          { minLength: 1, maxLength: 10 },
        ),
        async (roomId, sinceDate, threadConfigs) => {
          mockQuery.mockReset();

          const sinceDateISO = sinceDate.toISOString();

          // Create thread items with various statuses and updatedAt dates
          const threadItems: ThreadItem[] = threadConfigs.map((cfg, i) => ({
            PK: `ROOM#${roomId}` as ThreadItem['PK'],
            SK: `THREAD#${cfg.threadId}` as ThreadItem['SK'],
            GSI1PK: `ROOM#${roomId}` as ThreadItem['GSI1PK'],
            GSI1SK: `STATUS#${cfg.status}#DATE#${cfg.updatedAt}` as ThreadItem['GSI1SK'],
            entityType: 'THREAD' as const,
            threadId: cfg.threadId,
            roomId: roomId as string,
            title: cfg.title,
            status: cfg.status,
            createdBy: 'user-1',
            createdAt: cfg.updatedAt,
            updatedAt: cfg.updatedAt,
            supersededBy: cfg.supersededBy,
          }));

          mockQuery.mockImplementation(async (params: { pk: string; skPrefix?: string }) => {
            if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'ADR#') {
              return { ok: true, value: [] }; // No ADRs for this test
            }
            if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'THREAD#') {
              return { ok: true, value: threadItems };
            }
            return { ok: true, value: [] };
          });

          const result = await summarizeChangesSince({
            roomId,
            sinceDate,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const summary = result.value;

          // Verify: supersededThreads only contains threads with SUPERSEDED status AND updatedAt > sinceDate
          const expectedSuperseded = threadItems.filter(
            (t) => t.status === 'SUPERSEDED' && t.updatedAt > sinceDateISO,
          );

          expect(summary.supersededThreads.length).toBe(expectedSuperseded.length);

          for (const st of summary.supersededThreads) {
            const originalThread = threadItems.find((t) => t.threadId === st.threadId);
            expect(originalThread).toBeDefined();
            expect(originalThread!.status).toBe('SUPERSEDED');
            expect(originalThread!.updatedAt > sinceDateISO).toBe(true);
          }

          // Verify no non-SUPERSEDED threads or those before sinceDate are included
          for (const thread of threadItems) {
            if (thread.status !== 'SUPERSEDED' || thread.updatedAt <= sinceDateISO) {
              expect(
                summary.supersededThreads.find((st) => st.threadId === thread.threadId),
              ).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  it('totalChanges equals the sum of newADRs.length + threadsReferencingFocus.length + supersededThreads.length', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        threadIdArb,
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.array(isoDateArb, { minLength: 0, maxLength: 8 }),
        fc.array(
          fc.record({
            status: threadStatusArb,
            updatedAt: isoDateArb,
            threadId: fc.uuid(),
            title: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
            supersededBy: fc.option(fc.uuid(), { nil: undefined }),
          }),
          { minLength: 0, maxLength: 8 },
        ),
        fc.array(
          fc.record({
            threadId: fc.uuid(),
            title: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
            hasXrefToFocus: fc.boolean(),
          }),
          { minLength: 0, maxLength: 5 },
        ),
        async (roomId, focusThreadId, sinceDate, adrDates, threadConfigs, referencingThreads) => {
          mockQuery.mockReset();

          const sinceDateISO = sinceDate.toISOString();

          // Create ADR items
          const adrItems: ADRItem[] = adrDates.map((createdAt, i) => ({
            PK: `ROOM#${roomId}` as ADRItem['PK'],
            SK: `ADR#adr-${i}` as ADRItem['SK'],
            GSI3PK: `ROOM#${roomId}` as ADRItem['GSI3PK'],
            GSI3SK: `ADR_SEQ#${String(i + 1).padStart(3, '0')}` as ADRItem['GSI3SK'],
            entityType: 'ADR' as const,
            adrId: `adr-${i}`,
            roomId: roomId as string,
            threadId: `thread-${i}`,
            sequentialId: i + 1,
            title: `ADR ${i}`,
            status: 'ACTIVE' as const,
            date: createdAt,
            context: 'ctx',
            optionsConsidered: [{ name: 'opt', summary: 'sum' }],
            decision: 'dec',
            consequences: 'con',
            relatedDecisions: [],
            createdAt,
            updatedAt: createdAt,
          }));

          // Create thread items for superseded check (distinct from referencing threads)
          const threadItemsForSuperseded: ThreadItem[] = threadConfigs.map((cfg) => ({
            PK: `ROOM#${roomId}` as ThreadItem['PK'],
            SK: `THREAD#${cfg.threadId}` as ThreadItem['SK'],
            GSI1PK: `ROOM#${roomId}` as ThreadItem['GSI1PK'],
            GSI1SK: `STATUS#${cfg.status}#DATE#${cfg.updatedAt}` as ThreadItem['GSI1SK'],
            entityType: 'THREAD' as const,
            threadId: cfg.threadId,
            roomId: roomId as string,
            title: cfg.title,
            status: cfg.status,
            createdBy: 'user-1',
            createdAt: cfg.updatedAt,
            updatedAt: cfg.updatedAt,
            supersededBy: cfg.supersededBy,
          }));

          // Create threads that reference the focus thread
          const referencingThreadItems: ThreadItem[] = referencingThreads
            .filter((rt) => rt.threadId !== (focusThreadId as string))
            .map((rt) => ({
              PK: `ROOM#${roomId}` as ThreadItem['PK'],
              SK: `THREAD#${rt.threadId}` as ThreadItem['SK'],
              GSI1PK: `ROOM#${roomId}` as ThreadItem['GSI1PK'],
              GSI1SK: `STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00.000Z` as ThreadItem['GSI1SK'],
              entityType: 'THREAD' as const,
              threadId: rt.threadId,
              roomId: roomId as string,
              title: rt.title,
              status: 'IN_PROGRESS' as ThreadStatus,
              createdBy: 'user-1',
              createdAt: '2024-01-01T00:00:00.000Z',
              updatedAt: '2024-01-01T00:00:00.000Z',
            }));

          // Combine all thread items (deduplicate by threadId)
          const allThreadIds = new Set<string>();
          const allThreadItems: ThreadItem[] = [];
          for (const t of [...referencingThreadItems, ...threadItemsForSuperseded]) {
            if (!allThreadIds.has(t.threadId)) {
              allThreadIds.add(t.threadId);
              allThreadItems.push(t);
            }
          }

          // Build cross-reference items for threads that reference focus
          const xrefItems: Map<string, CrossReferenceItem[]> = new Map();
          for (const rt of referencingThreads) {
            if (rt.hasXrefToFocus && rt.threadId !== (focusThreadId as string)) {
              xrefItems.set(rt.threadId, [
                {
                  PK: `THREAD#${rt.threadId}` as CrossReferenceItem['PK'],
                  SK: `XREF#${focusThreadId}` as CrossReferenceItem['SK'],
                  entityType: 'CROSS_REFERENCE' as const,
                  sourceThreadId: rt.threadId,
                  targetThreadId: focusThreadId as string,
                  referenceType: 'RELATED_TO' as ReferenceType,
                  description: 'Related',
                  createdAt: '2024-01-01T00:00:00.000Z',
                },
              ]);
            }
          }

          mockQuery.mockImplementation(
            async (params: { pk: string; skPrefix?: string; limit?: number }) => {
              if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'ADR#') {
                return { ok: true, value: adrItems };
              }
              if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'THREAD#') {
                return { ok: true, value: allThreadItems };
              }
              // Cross-reference lookups for specific threads
              if (params.pk.startsWith('THREAD#') && params.skPrefix?.startsWith('XREF#')) {
                const tId = params.pk.replace('THREAD#', '');
                const items = xrefItems.get(tId) ?? [];
                return { ok: true, value: items };
              }
              return { ok: true, value: [] };
            },
          );

          const result = await summarizeChangesSince({
            roomId,
            sinceDate,
            focusThreadId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const summary = result.value;

          // The core property: totalChanges === sum of all arrays' lengths
          expect(summary.totalChanges).toBe(
            summary.newADRs.length +
              summary.threadsReferencingFocus.length +
              summary.supersededThreads.length,
          );
        },
      ),
      { numRuns: 100 },
    );
  });

  it('threadsReferencingFocus contains exactly the threads that have cross-references to the focus thread', async () => {
    await fc.assert(
      fc.asyncProperty(
        roomIdArb,
        threadIdArb,
        fc.date({ min: new Date('2022-01-01'), max: new Date('2028-12-31') }),
        fc.array(
          fc.record({
            threadId: fc.uuid(),
            title: fc.string({ minLength: 1, maxLength: 50 }).filter((s) => s.trim().length > 0),
            hasXrefToFocus: fc.boolean(),
            referenceType: referenceTypeArb,
          }),
          { minLength: 1, maxLength: 8 },
        ),
        async (roomId, focusThreadId, sinceDate, referencingThreadConfigs) => {
          mockQuery.mockReset();

          // Filter out threads that have the same ID as focusThread (would be skipped)
          const configs = referencingThreadConfigs.filter(
            (c) => c.threadId !== (focusThreadId as string),
          );

          const threadItems: ThreadItem[] = configs.map((cfg) => ({
            PK: `ROOM#${roomId}` as ThreadItem['PK'],
            SK: `THREAD#${cfg.threadId}` as ThreadItem['SK'],
            GSI1PK: `ROOM#${roomId}` as ThreadItem['GSI1PK'],
            GSI1SK: `STATUS#IN_PROGRESS#DATE#2024-01-01T00:00:00.000Z` as ThreadItem['GSI1SK'],
            entityType: 'THREAD' as const,
            threadId: cfg.threadId,
            roomId: roomId as string,
            title: cfg.title,
            status: 'IN_PROGRESS' as ThreadStatus,
            createdBy: 'user-1',
            createdAt: '2024-01-01T00:00:00.000Z',
            updatedAt: '2024-01-01T00:00:00.000Z',
          }));

          // Build cross-reference map
          const xrefMap: Map<string, CrossReferenceItem[]> = new Map();
          for (const cfg of configs) {
            if (cfg.hasXrefToFocus) {
              xrefMap.set(cfg.threadId, [
                {
                  PK: `THREAD#${cfg.threadId}` as CrossReferenceItem['PK'],
                  SK: `XREF#${focusThreadId}` as CrossReferenceItem['SK'],
                  entityType: 'CROSS_REFERENCE' as const,
                  sourceThreadId: cfg.threadId,
                  targetThreadId: focusThreadId as string,
                  referenceType: cfg.referenceType,
                  description: 'reference',
                  createdAt: '2024-01-01T00:00:00.000Z',
                },
              ]);
            }
          }

          mockQuery.mockImplementation(
            async (params: { pk: string; skPrefix?: string; limit?: number }) => {
              if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'ADR#') {
                return { ok: true, value: [] };
              }
              if (params.pk === `ROOM#${roomId}` && params.skPrefix === 'THREAD#') {
                return { ok: true, value: threadItems };
              }
              if (params.pk.startsWith('THREAD#') && params.skPrefix?.startsWith('XREF#')) {
                const tId = params.pk.replace('THREAD#', '');
                return { ok: true, value: xrefMap.get(tId) ?? [] };
              }
              return { ok: true, value: [] };
            },
          );

          const result = await summarizeChangesSince({
            roomId,
            sinceDate,
            focusThreadId,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const summary = result.value;

          // Expected referencing threads: those with hasXrefToFocus = true
          const expectedReferencing = configs.filter((c) => c.hasXrefToFocus);

          expect(summary.threadsReferencingFocus.length).toBe(expectedReferencing.length);

          // Each thread in threadsReferencingFocus should have a cross-reference to the focus
          for (const ref of summary.threadsReferencingFocus) {
            const cfg = configs.find((c) => c.threadId === ref.threadId);
            expect(cfg).toBeDefined();
            expect(cfg!.hasXrefToFocus).toBe(true);
          }

          // Threads without cross-references to focus should not appear
          for (const cfg of configs) {
            if (!cfg.hasXrefToFocus) {
              expect(
                summary.threadsReferencingFocus.find((r) => r.threadId === cfg.threadId),
              ).toBeUndefined();
            }
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});
