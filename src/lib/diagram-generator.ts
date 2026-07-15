import { Result, ok, err } from '@/types/result';
import { DecisionThread, Option, DiagramFile } from '@/types/domain';
import { invokeClaudeModel } from '@/services/bedrock';
import { uploadDocument } from '@/services/s3';

// =============================================================================
// Error Type
// =============================================================================

export type DiagramError =
  | { kind: 'GENERATION_FAILURE'; cause: string }
  | { kind: 'S3_UPLOAD_FAILURE'; cause: string }
  | { kind: 'NOT_INFRASTRUCTURE'; reason: string };

// =============================================================================
// Infrastructure Keywords
// =============================================================================

const INFRASTRUCTURE_KEYWORDS = [
  'cloud',
  'networking',
  'deployment',
  'containers',
  'container',
  'databases',
  'database',
  'storage',
  'messaging',
  'compute',
  'kubernetes',
  'k8s',
  'lambda',
  's3',
  'ec2',
  'ecs',
  'fargate',
  'docker',
  'vpc',
  'load balancer',
  'cdn',
  'api gateway',
  'microservices',
  'serverless',
  'terraform',
  'cloudformation',
  'cdk',
  'ci/cd',
  'pipeline',
  'redis',
  'kafka',
  'sqs',
  'sns',
  'rds',
  'dynamodb',
  'aurora',
  'elasticsearch',
  'opensearch',
  'cloudfront',
  'route53',
  'nginx',
  'ingress',
  'service mesh',
  'istio',
  'helm',
  'iam',
  'subnet',
  'firewall',
  'nat gateway',
  'bastion',
  'auto scaling',
  'autoscaling',
  'orchestration',
  'queue',
  'event bus',
  'eventbridge',
  'kinesis',
  'glue',
  'emr',
  'batch',
];

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Determines whether a decided thread involves infrastructure-related architecture.
 * Checks thread title for infrastructure keywords.
 */
export function isInfrastructureDecision(thread: DecisionThread): boolean {
  const textToCheck = thread.title.toLowerCase();

  return INFRASTRUCTURE_KEYWORDS.some((keyword) => textToCheck.includes(keyword));
}

/**
 * Generates a .drawio diagram for a DECIDED thread showing system components,
 * connections, and data flow direction.
 */
export async function generateDecisionDiagram(params: {
  thread: DecisionThread;
  selectedOption: Option;
}): Promise<Result<DiagramFile, DiagramError>> {
  const { thread, selectedOption } = params;

  if (!isInfrastructureDecision(thread)) {
    return err({
      kind: 'NOT_INFRASTRUCTURE',
      reason: `Thread "${thread.title}" does not involve infrastructure-related architecture`,
    });
  }

  const systemPrompt = `You are an architecture diagram generator. You produce .drawio XML diagrams for infrastructure decisions. 
Your output must be ONLY valid .drawio XML — no explanations, no markdown fences, just the XML content.
The diagram should clearly show:
1. All system components involved in the architecture
2. Connections between components with arrows
3. Data flow direction indicated by arrow direction
4. Labels on connections describing what flows between components

Use mxGraphModel format compatible with draw.io/diagrams.net.`;

  const userMessage = `Generate a .drawio architecture diagram for this decided infrastructure decision:

Title: ${thread.title}
Selected Option: ${selectedOption.summary}
Benefits: ${selectedOption.benefits.join(', ')}
Complexity: ${selectedOption.complexity}

Create a diagram showing the system components, their connections, and data flow direction for this architecture decision. Output ONLY the .drawio XML content.`;

  const result = await invokeClaudeModel({
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 8192,
    temperature: 0.3,
  });

  if (!result.ok) {
    return err({
      kind: 'GENERATION_FAILURE',
      cause: `Bedrock invocation failed: ${result.error.kind}`,
    });
  }

  const xmlContent = extractXmlContent(result.value);
  const components = extractComponents(xmlContent);
  const connections = extractConnections(xmlContent);

  const fileName = generateFileName(thread.title);

  const diagramFile: DiagramFile = {
    fileName,
    content: xmlContent,
    components,
    connections,
  };

  return ok(diagramFile);
}

/**
 * Generates a draft comparison diagram during deliberation showing each option
 * as a separate labeled section with components and connections.
 */
export async function generateOptionComparisonDiagram(params: {
  thread: DecisionThread;
  options: Option[];
}): Promise<Result<DiagramFile, DiagramError>> {
  const { thread, options } = params;

  if (!isInfrastructureDecision(thread)) {
    return err({
      kind: 'NOT_INFRASTRUCTURE',
      reason: `Thread "${thread.title}" does not involve infrastructure-related architecture`,
    });
  }

  const systemPrompt = `You are an architecture diagram generator. You produce .drawio XML diagrams that compare multiple architecture options side by side.
Your output must be ONLY valid .drawio XML — no explanations, no markdown fences, just the XML content.
Each option must appear as a clearly labeled, separate section in the diagram.
Each section should show:
1. The option name/summary as a header
2. System components for that option
3. Connections between components with data flow arrows
4. Labels on connections

Use mxGraphModel format compatible with draw.io/diagrams.net. Arrange options horizontally so they can be compared visually.`;

  const optionDescriptions = options
    .map(
      (opt, i) =>
        `Option ${i + 1}: ${opt.summary}\n  Benefits: ${opt.benefits.join(', ')}\n  Risks: ${opt.risks.join(', ')}\n  Complexity: ${opt.complexity}`
    )
    .join('\n\n');

  const userMessage = `Generate a .drawio comparison diagram for this architecture decision under deliberation:

Title: ${thread.title}

Options to compare:
${optionDescriptions}

Create a diagram with each option as a separate labeled section, showing their respective components, connections, and data flow. Output ONLY the .drawio XML content.`;

  const result = await invokeClaudeModel({
    systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
    maxTokens: 8192,
    temperature: 0.3,
  });

  if (!result.ok) {
    return err({
      kind: 'GENERATION_FAILURE',
      cause: `Bedrock invocation failed: ${result.error.kind}`,
    });
  }

  const xmlContent = extractXmlContent(result.value);
  const components = extractComponents(xmlContent);
  const connections = extractConnections(xmlContent);

  const fileName = generateFileName(thread.title, 'comparison');

  const diagramFile: DiagramFile = {
    fileName,
    content: xmlContent,
    components,
    connections,
  };

  return ok(diagramFile);
}

/**
 * Uploads a generated diagram to S3 and returns the object key and file name.
 * Failure does not block thread transitions (Requirement 8.4).
 */
export async function uploadDiagram(
  diagram: DiagramFile,
  roomId?: string
): Promise<Result<{ s3Key: string; fileName: string }, DiagramError>> {
  const s3Key = roomId
    ? `diagrams/${roomId}/${diagram.fileName}`
    : `diagrams/${diagram.fileName}`;

  const uploadResult = await uploadDocument({
    key: s3Key,
    body: diagram.content,
    contentType: 'application/xml',
  });

  if (!uploadResult.ok) {
    const cause =
      uploadResult.error.kind === 'NOT_FOUND'
        ? `Object not found: ${uploadResult.error.key}`
        : uploadResult.error.cause;
    return err({
      kind: 'S3_UPLOAD_FAILURE',
      cause,
    });
  }

  return ok({ s3Key, fileName: diagram.fileName });
}

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Extracts .drawio XML content from the model response, stripping any
 * markdown fences or surrounding text if present.
 */
function extractXmlContent(response: string): string {
  // Try to extract XML from markdown code block if present
  const xmlBlockMatch = response.match(/```(?:xml)?\s*\n?([\s\S]*?)\n?```/);
  if (xmlBlockMatch) {
    return xmlBlockMatch[1].trim();
  }

  // Try to extract content starting with <?xml or <mxfile or <mxGraphModel
  const xmlStartMatch = response.match(
    /(<\?xml[\s\S]*|<mxfile[\s\S]*|<mxGraphModel[\s\S]*)/
  );
  if (xmlStartMatch) {
    return xmlStartMatch[1].trim();
  }

  // Return the raw response if no XML markers found
  return response.trim();
}

/**
 * Extracts component names from .drawio XML by parsing mxCell value attributes.
 */
function extractComponents(xml: string): string[] {
  const components: string[] = [];

  // Match mxCell elements that have a value attribute (these are labeled nodes)
  const cellRegex = /<mxCell[^>]*\bvalue="([^"]+)"[^>]*\bvertex="1"/g;
  let match: RegExpExecArray | null;
  while ((match = cellRegex.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1]);
    if (value && !isConnectionLabel(value)) {
      components.push(value);
    }
  }

  // Also match UserObject elements with label attributes
  const userObjectRegex = /<UserObject[^>]*\blabel="([^"]+)"/g;
  while ((match = userObjectRegex.exec(xml)) !== null) {
    const value = decodeXmlEntities(match[1]);
    if (value) {
      components.push(value);
    }
  }

  // Deduplicate
  const seen = new Set<string>();
  return components.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * Extracts connections from .drawio XML by finding edge mxCells and resolving
 * their source/target to component names.
 */
function extractConnections(xml: string): { from: string; to: string; label?: string }[] {
  const connections: { from: string; to: string; label?: string }[] = [];

  // Build a map of cell id → value for vertex cells
  const cellValues = new Map<string, string>();
  const vertexRegex = /<mxCell[^>]*\bid="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*\bvertex="1"/g;
  let match: RegExpExecArray | null;
  while ((match = vertexRegex.exec(xml)) !== null) {
    cellValues.set(match[1], decodeXmlEntities(match[2]));
  }

  // Find edge cells with source and target
  const edgeRegex = /<mxCell[^>]*\bedge="1"[^>]*\bsource="([^"]+)"[^>]*\btarget="([^"]+)"[^>]*(?:\bvalue="([^"]*)")?[^>]*/g;
  while ((match = edgeRegex.exec(xml)) !== null) {
    const sourceId = match[1];
    const targetId = match[2];
    const label = match[3] ? decodeXmlEntities(match[3]) : undefined;

    const from = cellValues.get(sourceId) ?? sourceId;
    const to = cellValues.get(targetId) ?? targetId;

    connections.push({ from, to, ...(label ? { label } : {}) });
  }

  // Also try alternate edge patterns where attributes appear in different order
  const altEdgeRegex = /<mxCell[^>]*\bid="([^"]+)"[^>]*\bvalue="([^"]*)"[^>]*\bedge="1"[^>]*/g;
  while ((match = altEdgeRegex.exec(xml)) !== null) {
    const fullMatch = match[0];
    const sourceMatch = fullMatch.match(/\bsource="([^"]+)"/);
    const targetMatch = fullMatch.match(/\btarget="([^"]+)"/);
    if (sourceMatch && targetMatch) {
      const from = cellValues.get(sourceMatch[1]) ?? sourceMatch[1];
      const to = cellValues.get(targetMatch[1]) ?? targetMatch[1];
      const label = match[2] ? decodeXmlEntities(match[2]) : undefined;

      // Avoid duplicate entries
      const exists = connections.some(
        (c) => c.from === from && c.to === to && c.label === label
      );
      if (!exists) {
        connections.push({ from, to, ...(label ? { label } : {}) });
      }
    }
  }

  return connections;
}

/**
 * Decodes basic XML entities in attribute values.
 */
function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#xA;/g, '\n');
}

/**
 * Heuristic to determine if a cell value is likely a connection label
 * rather than a component name (e.g., short arrow-like text).
 */
function isConnectionLabel(value: string): boolean {
  const trimmed = value.trim();
  // Empty or very short values with arrow-like chars are likely labels
  if (trimmed.length === 0) return true;
  if (/^[→←↑↓⟶⟵]+$/.test(trimmed)) return true;
  return false;
}

/**
 * Generates a file name for the diagram based on the thread title.
 */
function generateFileName(title: string, suffix?: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);

  const suffixPart = suffix ? `-${suffix}` : '';
  return `${slug}${suffixPart}.drawio`;
}
