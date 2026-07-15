import { describe, it, expect, vi, beforeEach } from 'vitest';
import fc from 'fast-check';

// =============================================================================
// Shared Mocks
// =============================================================================

const mockInvokeClaudeModel = vi.hoisted(() => vi.fn());

vi.mock('@/services/bedrock', () => ({
  invokeClaudeModel: mockInvokeClaudeModel,
}));

vi.mock('@/services/s3', () => ({
  uploadDocument: vi.fn().mockResolvedValue({ ok: true, value: { key: 'test', url: 'test' } }),
}));

import { generateDecisionDiagram, generateOptionComparisonDiagram, isInfrastructureDecision } from '@/lib/diagram-generator';
import type { DecisionThread, Option, ThreadId, RoomId } from '@/types/domain';

// =============================================================================
// Shared Generators
// =============================================================================

const threadIdArb = fc.uuid().map((id) => id as ThreadId);
const roomIdArb = fc.uuid().map((id) => id as RoomId);

const isoDateArb = fc
  .date({ min: new Date('2020-01-01'), max: new Date('2030-12-31') })
  .map((d) => d.toISOString());

/** Infrastructure keywords that make isInfrastructureDecision return true */
const INFRA_KEYWORDS = [
  'cloud', 'deployment', 'containers', 'database', 'kubernetes',
  'lambda', 'serverless', 'docker', 'microservices', 'pipeline',
];

/** Generates a thread title guaranteed to contain an infrastructure keyword */
const infraTitleArb = fc
  .tuple(
    fc.string({ minLength: 0, maxLength: 30 }),
    fc.constantFrom(...INFRA_KEYWORDS),
    fc.string({ minLength: 0, maxLength: 30 }),
  )
  .map(([prefix, keyword, suffix]) => `${prefix} ${keyword} ${suffix}`.trim());

/** Generates a thread title guaranteed to NOT contain infrastructure keywords */
const nonInfraTitleArb = fc
  .string({ minLength: 1, maxLength: 100 })
  .filter((s) => s.trim().length > 0)
  .filter((s) => {
    const lower = s.toLowerCase();
    return !INFRA_KEYWORDS.some((kw) => lower.includes(kw)) &&
      !lower.includes('networking') && !lower.includes('storage') &&
      !lower.includes('messaging') && !lower.includes('compute') &&
      !lower.includes('k8s') && !lower.includes('s3') &&
      !lower.includes('ec2') && !lower.includes('ecs') &&
      !lower.includes('fargate') && !lower.includes('vpc') &&
      !lower.includes('load balancer') && !lower.includes('cdn') &&
      !lower.includes('api gateway') && !lower.includes('terraform') &&
      !lower.includes('cloudformation') && !lower.includes('cdk') &&
      !lower.includes('ci/cd') && !lower.includes('redis') &&
      !lower.includes('kafka') && !lower.includes('sqs') &&
      !lower.includes('sns') && !lower.includes('rds') &&
      !lower.includes('dynamodb') && !lower.includes('aurora') &&
      !lower.includes('elasticsearch') && !lower.includes('opensearch') &&
      !lower.includes('cloudfront') && !lower.includes('route53') &&
      !lower.includes('nginx') && !lower.includes('ingress') &&
      !lower.includes('service mesh') && !lower.includes('istio') &&
      !lower.includes('helm') && !lower.includes('iam') &&
      !lower.includes('subnet') && !lower.includes('firewall') &&
      !lower.includes('nat gateway') && !lower.includes('bastion') &&
      !lower.includes('auto scaling') && !lower.includes('autoscaling') &&
      !lower.includes('orchestration') && !lower.includes('queue') &&
      !lower.includes('event bus') && !lower.includes('eventbridge') &&
      !lower.includes('kinesis') && !lower.includes('glue') &&
      !lower.includes('emr') && !lower.includes('batch') &&
      !lower.includes('databases') && !lower.includes('container');
  });

/** Generates a DECIDED thread with an infrastructure-related title */
const decidedInfraThreadArb: fc.Arbitrary<DecisionThread> = fc.record({
  threadId: threadIdArb,
  roomId: roomIdArb,
  title: infraTitleArb,
  status: fc.constant('DECIDED' as const),
  createdBy: fc.string({ minLength: 1, maxLength: 50 }),
  createdAt: isoDateArb,
  updatedAt: isoDateArb,
  selectedOption: fc.string({ minLength: 1, maxLength: 200 }),
});

/** Generates an IN_PROGRESS thread with an infrastructure title */
const inProgressInfraThreadArb: fc.Arbitrary<DecisionThread> = fc.record({
  threadId: threadIdArb,
  roomId: roomIdArb,
  title: infraTitleArb,
  status: fc.constant('IN_PROGRESS' as const),
  createdBy: fc.string({ minLength: 1, maxLength: 50 }),
  createdAt: isoDateArb,
  updatedAt: isoDateArb,
});

/** Generates an IN_PROGRESS thread with a non-infrastructure title */
const inProgressNonInfraThreadArb: fc.Arbitrary<DecisionThread> = fc.record({
  threadId: threadIdArb,
  roomId: roomIdArb,
  title: nonInfraTitleArb,
  status: fc.constant('IN_PROGRESS' as const),
  createdBy: fc.string({ minLength: 1, maxLength: 50 }),
  createdAt: isoDateArb,
  updatedAt: isoDateArb,
});

/** Generates a valid Option with required fields */
const optionArb: fc.Arbitrary<Option> = fc.record({
  summary: fc.string({ minLength: 1, maxLength: 200 }).filter((s) => s.trim().length > 0),
  benefits: fc.array(
    fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    { minLength: 2, maxLength: 5 },
  ),
  risks: fc.array(
    fc.string({ minLength: 1, maxLength: 100 }).filter((s) => s.trim().length > 0),
    { minLength: 2, maxLength: 5 },
  ),
  complexity: fc.constantFrom('Low', 'Medium', 'High') as fc.Arbitrary<'Low' | 'Medium' | 'High'>,
});

/** Generates 2-5 options for comparison */
const optionsArrayArb = fc.array(optionArb, { minLength: 2, maxLength: 5 });

// =============================================================================
// Helper: Generate mock .drawio XML with components and connections
// =============================================================================

/**
 * Builds a valid .drawio XML string with parameterized components and edges.
 */
function buildMockDrawioXml(components: string[], edgeLabels: string[]): string {
  const vertexCells = components
    .map(
      (name, i) =>
        `<mxCell id="${i + 2}" value="${name}" style="rounded=1;" vertex="1" parent="1"><mxGeometry x="${i * 200}" y="100" width="120" height="60" as="geometry"/></mxCell>`,
    )
    .join('\n        ');

  const edgeCells = components
    .slice(0, -1)
    .map((_, i) => {
      const label = edgeLabels[i % edgeLabels.length] || 'data';
      return `<mxCell id="${components.length + i + 2}" value="${label}" edge="1" source="${i + 2}" target="${i + 3}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`;
    })
    .join('\n        ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile>
  <diagram name="Architecture">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${vertexCells}
        ${edgeCells}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

/**
 * Builds a .drawio XML string with one section per option for comparison diagrams.
 */
function buildMockComparisonDrawioXml(options: Option[]): string {
  let cellId = 2;
  const cells: string[] = [];

  for (let i = 0; i < options.length; i++) {
    const optLabel = `Option ${i + 1}`;
    const compAId = cellId++;
    const compBId = cellId++;
    const edgeId = cellId++;

    cells.push(
      `<mxCell id="${compAId}" value="${optLabel} - API Gateway" vertex="1" parent="1"><mxGeometry x="${i * 300}" y="50" width="120" height="60" as="geometry"/></mxCell>`,
    );
    cells.push(
      `<mxCell id="${compBId}" value="${optLabel} - Lambda" vertex="1" parent="1"><mxGeometry x="${i * 300}" y="200" width="120" height="60" as="geometry"/></mxCell>`,
    );
    cells.push(
      `<mxCell id="${edgeId}" value="HTTP" edge="1" source="${compAId}" target="${compBId}" parent="1"><mxGeometry relative="1" as="geometry"/></mxCell>`,
    );
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<mxfile>
  <diagram name="Options Comparison">
    <mxGraphModel>
      <root>
        <mxCell id="0"/>
        <mxCell id="1" parent="0"/>
        ${cells.join('\n        ')}
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>`;
}

/** Arbitrary that generates mock .drawio XML with ≥2 components and ≥1 edge */
const drawioXmlArb = fc
  .tuple(
    fc.array(
      fc.string({ minLength: 1, maxLength: 30 }).filter((s) => /^[a-zA-Z0-9 _-]+$/.test(s) && s.trim().length > 0),
      { minLength: 2, maxLength: 6 },
    ),
    fc.array(
      fc.string({ minLength: 1, maxLength: 20 }).filter((s) => /^[a-zA-Z0-9 _-]+$/.test(s) && s.trim().length > 0),
      { minLength: 1, maxLength: 4 },
    ),
  )
  .map(([componentNames, edgeLabels]) => {
    const uniqueComponents = [...new Set(componentNames)];
    if (uniqueComponents.length < 2) {
      uniqueComponents.push('ComponentA', 'ComponentB');
    }
    return buildMockDrawioXml(uniqueComponents, edgeLabels);
  });

// =============================================================================
// Property 29: Diagram generation for infrastructure decisions
// =============================================================================

/**
 * Property 29: Diagram generation for infrastructure decisions
 *
 * For any DECIDED thread where `isInfrastructureDecision` is true,
 * `generateDecisionDiagram` produces a DiagramFile with valid .drawio XML,
 * ≥1 component, ≥1 connection with data flow, and non-empty fileName.
 *
 * **Validates: Requirements 8.1, 8.2**
 */
describe('Property 29: Diagram generation for infrastructure decisions', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('isInfrastructureDecision returns true for threads with infrastructure keywords in title', () => {
    fc.assert(
      fc.property(decidedInfraThreadArb, (thread) => {
        expect(isInfrastructureDecision(thread)).toBe(true);
      }),
      { numRuns: 100 },
    );
  });

  it('isInfrastructureDecision returns false for threads without infrastructure keywords', () => {
    const nonInfraDecidedThreadArb: fc.Arbitrary<DecisionThread> = fc.record({
      threadId: threadIdArb,
      roomId: roomIdArb,
      title: nonInfraTitleArb,
      status: fc.constant('DECIDED' as const),
      createdBy: fc.string({ minLength: 1, maxLength: 50 }),
      createdAt: isoDateArb,
      updatedAt: isoDateArb,
    });

    fc.assert(
      fc.property(nonInfraDecidedThreadArb, (thread) => {
        expect(isInfrastructureDecision(thread)).toBe(false);
      }),
      { numRuns: 100 },
    );
  });

  it('for any DECIDED infrastructure thread, generateDecisionDiagram produces a DiagramFile with non-empty fileName ending in .drawio', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedInfraThreadArb,
        optionArb,
        drawioXmlArb,
        async (thread, selectedOption, mockXml) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateDecisionDiagram({
            thread,
            selectedOption,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // fileName is non-empty and ends with .drawio
          expect(diagram.fileName.length).toBeGreaterThan(0);
          expect(diagram.fileName).toMatch(/\.drawio$/);
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any DECIDED infrastructure thread, generateDecisionDiagram produces non-empty XML content', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedInfraThreadArb,
        optionArb,
        drawioXmlArb,
        async (thread, selectedOption, mockXml) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateDecisionDiagram({
            thread,
            selectedOption,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // content is non-empty and contains XML
          expect(diagram.content.length).toBeGreaterThan(0);
          expect(diagram.content).toContain('<mxGraphModel');
        },
      ),
      { numRuns: 100 },
    );
  });

  it('for any DECIDED infrastructure thread, generateDecisionDiagram produces ≥1 component and ≥1 connection with from/to', async () => {
    await fc.assert(
      fc.asyncProperty(
        decidedInfraThreadArb,
        optionArb,
        drawioXmlArb,
        async (thread, selectedOption, mockXml) => {
          mockInvokeClaudeModel.mockReset();

          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateDecisionDiagram({
            thread,
            selectedOption,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // components array has ≥1 item
          expect(diagram.components.length).toBeGreaterThanOrEqual(1);

          // connections array has ≥1 item with from and to
          expect(diagram.connections.length).toBeGreaterThanOrEqual(1);
          for (const connection of diagram.connections) {
            expect(connection.from).toBeDefined();
            expect(connection.from.length).toBeGreaterThan(0);
            expect(connection.to).toBeDefined();
            expect(connection.to.length).toBeGreaterThan(0);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

// =============================================================================
// Property 30: Option comparison diagram during deliberation
// =============================================================================

/**
 * Property 30: Option comparison diagram during deliberation
 *
 * For any 2-5 options in an IN_PROGRESS thread, `generateOptionComparisonDiagram`
 * produces a DiagramFile where each option appears as a separately labeled section
 * with its components and connections.
 *
 * **Validates: Requirements 8.3**
 */
describe('Property 30: Option comparison diagram during deliberation', () => {
  beforeEach(() => {
    mockInvokeClaudeModel.mockReset();
  });

  it('for any 2-5 options and an IN_PROGRESS infrastructure thread, produces a DiagramFile with valid .drawio fileName, non-empty XML content, ≥1 component, and ≥1 connection', async () => {
    await fc.assert(
      fc.asyncProperty(
        inProgressInfraThreadArb,
        optionsArrayArb,
        async (thread, options) => {
          mockInvokeClaudeModel.mockReset();

          const mockXml = buildMockComparisonDrawioXml(options);
          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateOptionComparisonDiagram({
            thread: thread as DecisionThread,
            options,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // fileName is non-empty and ends with .drawio
          expect(diagram.fileName.length).toBeGreaterThan(0);
          expect(diagram.fileName).toMatch(/\.drawio$/);

          // content is non-empty XML
          expect(diagram.content.length).toBeGreaterThan(0);
          expect(diagram.content).toContain('<mxGraphModel');

          // components array has ≥1 item
          expect(diagram.components.length).toBeGreaterThanOrEqual(1);

          // connections array has ≥1 item
          expect(diagram.connections.length).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('each option appears as a separately labeled section with its own components in the diagram', async () => {
    await fc.assert(
      fc.asyncProperty(
        inProgressInfraThreadArb,
        optionsArrayArb,
        async (thread, options) => {
          mockInvokeClaudeModel.mockReset();

          const mockXml = buildMockComparisonDrawioXml(options);
          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateOptionComparisonDiagram({
            thread: thread as DecisionThread,
            options,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // Each option should contribute labeled components
          for (let i = 0; i < options.length; i++) {
            const optionLabel = `Option ${i + 1}`;
            const hasComponentForOption = diagram.components.some(
              (c) => c.includes(optionLabel),
            );
            expect(hasComponentForOption).toBe(true);
          }

          // Each option contributes at least one connection
          expect(diagram.connections.length).toBeGreaterThanOrEqual(options.length);
        },
      ),
      { numRuns: 50 },
    );
  });

  it('returns NOT_INFRASTRUCTURE error for non-infrastructure threads', async () => {
    await fc.assert(
      fc.asyncProperty(
        inProgressNonInfraThreadArb,
        optionsArrayArb,
        async (thread, options) => {
          mockInvokeClaudeModel.mockReset();

          const result = await generateOptionComparisonDiagram({
            thread: thread as DecisionThread,
            options,
          });

          expect(result.ok).toBe(false);
          if (result.ok) return;

          expect(result.error.kind).toBe('NOT_INFRASTRUCTURE');
          expect(result.error.reason.length).toBeGreaterThan(0);

          // Should NOT have called the AI model
          expect(mockInvokeClaudeModel).not.toHaveBeenCalled();
        },
      ),
      { numRuns: 50 },
    );
  });

  it('fileName contains comparison suffix and ends with .drawio', async () => {
    await fc.assert(
      fc.asyncProperty(
        inProgressInfraThreadArb,
        optionsArrayArb,
        async (thread, options) => {
          mockInvokeClaudeModel.mockReset();

          const mockXml = buildMockComparisonDrawioXml(options);
          mockInvokeClaudeModel.mockResolvedValueOnce({
            ok: true,
            value: mockXml,
          });

          const result = await generateOptionComparisonDiagram({
            thread: thread as DecisionThread,
            options,
          });

          expect(result.ok).toBe(true);
          if (!result.ok) return;

          const diagram = result.value;

          // The function appends '-comparison' suffix to the file name
          expect(diagram.fileName).toContain('-comparison');
          expect(diagram.fileName).toMatch(/-comparison\.drawio$/);
        },
      ),
      { numRuns: 50 },
    );
  });
});
