/**
 * Domain types and interfaces for the Architecture Decision Room.
 * These types represent the core domain model shared across all layers.
 */

// =============================================================================
// Branded Types
// =============================================================================

/** Unique identifier for a Room (project workspace). */
export type RoomId = string & { __brand: 'RoomId' };

/** Unique identifier for a Decision Thread within a Room. */
export type ThreadId = string & { __brand: 'ThreadId' };

/** Unique identifier for a Team (Cognito group). */
export type TeamId = string & { __brand: 'TeamId' };

/** Unique identifier for a Message within a Thread. */
export type MessageId = string & { __brand: 'MessageId' };

/** Unique identifier for a User (Cognito identity). */
export type UserId = string & { __brand: 'UserId' };

// =============================================================================
// Enums and Union Types
// =============================================================================

/** Lifecycle state of a Decision Thread. */
export type ThreadStatus = 'DRAFT' | 'IN_PROGRESS' | 'DECIDED' | 'SUPERSEDED';

/** Role of a team member. */
export type TeamRole = 'admin' | 'member';

/** Status of a user within a team. */
export type UserStatus = 'active' | 'invited' | 'disabled';

/** Type of relationship between cross-referenced threads/ADRs. */
export type ReferenceType = 'SUPERSEDES' | 'DEPENDS_ON' | 'CONTRADICTS' | 'RELATED_TO';

/** Complexity rating for an architecture option. */
export type Complexity = 'Low' | 'Medium' | 'High';

// =============================================================================
// Core Domain Interfaces
// =============================================================================

/** A project-level workspace container holding decision threads. */
export interface Room {
  roomId: RoomId;
  teamId: TeamId;
  name: string;
  createdBy: string;
  createdAt: string; // ISO 8601
  threadCount: number;
}

/** A conversation focused on a single architecture decision. */
export interface DecisionThread {
  threadId: ThreadId;
  roomId: RoomId;
  title: string;
  status: ThreadStatus;
  createdBy: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
  selectedOption?: string;
  reopenMarkers?: { timestamp: string; reason: string }[];
  supersededBy?: ThreadId;
}

/** A message within a Decision Thread. */
export interface Message {
  messageId: MessageId;
  threadId: ThreadId;
  sender: string; // userId or 'ai_architect'
  content: string;
  structuredData?: {
    type: 'options' | 'tradeoff_table' | 'clarifying_questions' | 'adr';
    payload: unknown;
  };
  createdAt: string; // ISO 8601
}

/** An Architecture Decision Record generated from a decided thread. */
export interface ADR {
  adrId: string;
  roomId: RoomId;
  threadId: ThreadId;
  sequentialId: number;
  title: string;
  status: 'ACTIVE' | 'SUPERSEDED';
  date: string; // ISO 8601
  context: string;
  optionsConsidered: { name: string; summary: string }[];
  decision: string;
  consequences: string;
  relatedDecisions: { adrId: string; title: string; relationship: string }[];
  diagramS3Key?: string;
  s3ExportKey?: string;
  createdAt: string; // ISO 8601
  updatedAt: string; // ISO 8601
}

/** A link between Decision Threads or ADRs indicating a relationship. */
export interface CrossReference {
  sourceThreadId: ThreadId;
  targetThreadId: ThreadId;
  referenceType: ReferenceType;
  description: string;
  createdAt: string; // ISO 8601
}

// =============================================================================
// AI Architect Types
// =============================================================================

/** A single architecture option proposed by the AI Architect. */
export interface Option {
  summary: string;        // ≤200 characters
  benefits: string[];     // ≥2 items
  risks: string[];        // ≥2 items
  complexity: Complexity;
}

/** A set of options with an accompanying tradeoff table. */
export interface OptionProposal {
  options: Option[];              // 2-5 options
  tradeoffTable: TradeoffTable;
}

/** A comparison matrix of options against constraints. */
export interface TradeoffTable {
  options: string[];        // option identifiers/names (one per row)
  constraints: string[];    // constraint names (one per column)
  ratings: string[][];      // ratings[optionIndex][constraintIndex]
}

/** Tracks what changed between tradeoff table versions. */
export interface TradeoffChange {
  optionId: string;
  field: 'summary' | 'benefits' | 'risks' | 'complexity' | 'tradeoff_rating';
  constraintName?: string;       // for tradeoff_rating changes
  previousValue: string;
  newValue: string;
  reason: string;                // why this assessment changed
}

/** A clarifying question asked by the AI Architect. */
export interface ClarifyingQuestion {
  question: string;
  relevance: string; // explains why this question matters for the decision
}

/** Discriminated union for option proposal results. */
export type ProposalResult =
  | { kind: 'multiple_options'; proposal: OptionProposal }
  | { kind: 'single_option'; option: Option; relaxationSuggestions: string[] };

// =============================================================================
// Search Types
// =============================================================================

/** A single result from a semantic search query. */
export interface SearchResult {
  threadId: ThreadId;
  title: string;
  status: ThreadStatus;
  date: string;           // ISO 8601
  similarityScore: number; // 0-1
  summary: string;        // ≤200 characters
}

// =============================================================================
// Team Management Types
// =============================================================================

/** A member of a team with role and status information. */
export interface TeamMember {
  userId: UserId;
  email: string;
  role: TeamRole;
  status: UserStatus;
  invitedAt: string;       // ISO 8601
  invitedBy: UserId;
  lastActiveAt?: string;   // ISO 8601
}

// =============================================================================
// Cross-Reference and Change Summary Types
// =============================================================================

/** Summary of changes in a Room since a given date. */
export interface RoomChangeSummary {
  newADRs: { adrId: string; title: string; date: string }[];
  threadsReferencingFocus: { threadId: string; title: string; referenceType: ReferenceType }[];
  supersededThreads: { threadId: string; title: string; supersededBy: string }[];
  totalChanges: number;
}

// =============================================================================
// Diagram Types
// =============================================================================

/** A generated .drawio diagram file. */
export interface DiagramFile {
  fileName: string;           // e.g., "adr-003-deployment-pipeline.drawio"
  content: string;            // .drawio XML content
  components: string[];       // list of system components included
  connections: { from: string; to: string; label?: string }[]; // data flow
}

// =============================================================================
// DynamoDB Entity Item Interfaces
// =============================================================================

/** DynamoDB item representing a Room entity. */
export interface RoomItem {
  PK: `TEAM#${string}`;
  SK: `ROOM#${string}`;
  GSI2PK?: `USER#${string}`;
  GSI2SK?: `ROOM#${string}`;
  entityType: 'ROOM';
  roomId: string;
  teamId: string;
  name: string;
  createdBy: string;
  createdAt: string; // ISO 8601
  threadCount: number;
}

/** DynamoDB item representing a Decision Thread entity. */
export interface ThreadItem {
  PK: `ROOM#${string}`;
  SK: `THREAD#${string}`;
  GSI1PK: `ROOM#${string}`;
  GSI1SK: `STATUS#${ThreadStatus}#DATE#${string}`;
  entityType: 'THREAD';
  threadId: string;
  roomId: string;
  title: string;
  status: ThreadStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  selectedOption?: string;
  reopenMarkers?: { timestamp: string; reason: string }[];
  supersededBy?: string;
}

/** DynamoDB item representing a Message entity. */
export interface MessageItem {
  PK: `THREAD#${string}`;
  SK: `MSG#${string}#${string}`;
  entityType: 'MESSAGE';
  messageId: string;
  threadId: string;
  sender: string; // userId or 'ai_architect'
  content: string;
  structuredData?: {
    type: 'options' | 'tradeoff_table' | 'clarifying_questions' | 'adr';
    payload: unknown;
  };
  createdAt: string;
}

/** DynamoDB item representing an ADR entity. */
export interface ADRItem {
  PK: `ROOM#${string}`;
  SK: `ADR#${string}`;
  GSI3PK: `ROOM#${string}`;
  GSI3SK: `ADR_SEQ#${string}`; // zero-padded: ADR_SEQ#001
  entityType: 'ADR';
  adrId: string;
  roomId: string;
  threadId: string;
  sequentialId: number;
  title: string;
  status: 'ACTIVE' | 'SUPERSEDED';
  date: string;
  context: string;
  optionsConsidered: { name: string; summary: string }[];
  decision: string;
  consequences: string;
  relatedDecisions: { adrId: string; title: string; relationship: string }[];
  diagramS3Key?: string;
  s3ExportKey?: string;
  createdAt: string;
  updatedAt: string;
}

/** DynamoDB item representing a Cross-Reference entity. */
export interface CrossReferenceItem {
  PK: `THREAD#${string}`;
  SK: `XREF#${string}`;
  entityType: 'CROSS_REFERENCE';
  sourceThreadId: string;
  targetThreadId: string;
  referenceType: ReferenceType;
  description: string;
  createdAt: string;
}

/** DynamoDB item representing an Embedding entity. */
export interface EmbeddingItem {
  PK: `ROOM#${string}`;
  SK: `EMB#${string}#${string}`;
  entityType: 'EMBEDDING';
  roomId: string;
  entityId: string;
  entityTypeRef: 'THREAD' | 'ADR';
  embedding: number[]; // 1536-dimensional Titan vector
  textSummary: string; // ≤200 chars for search result display
  createdAt: string;
  updatedAt: string;
}

/** DynamoDB item representing a Team Member entity. */
export interface TeamMemberItem {
  PK: `TEAM#${string}`;
  SK: `MEMBER#${string}`;
  entityType: 'TEAM_MEMBER';
  teamId: string;
  userId: string;
  email: string;
  role: TeamRole;
  status: UserStatus;
  invitedBy: string;
  invitedAt: string;          // ISO 8601
  lastActiveAt?: string;
}
