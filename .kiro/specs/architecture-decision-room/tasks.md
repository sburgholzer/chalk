# Implementation Plan: Architecture Decision Room

## Overview

This plan implements Chalk — a serverless Architecture Decision Room built with Next.js 14, AWS Lambda, DynamoDB, Amazon Bedrock, and S3. Tasks are organized to build foundational types and infrastructure first, then layer in domain logic, AI integration, and frontend components. Each task builds on previous ones, ensuring no orphaned code.

## Tasks

- [ ] 1. Set up project foundation and shared types
  - [ ] 1.1 Initialize Next.js 14 project with TypeScript strict mode and configure Tailwind CSS, ESLint, and project structure (`src/app/`, `src/components/`, `src/lib/`, `src/services/`, `src/types/`, `infra/`)
    - Create `tsconfig.json` with strict mode enabled
    - Install dependencies: `next`, `react`, `tailwindcss`, `aws-sdk`, `zod`, `swr`, `fast-check` (dev), `uuid`
    - Create directory scaffolding matching the project structure
    - _Requirements: All (project foundation)_

  - [ ] 1.2 Implement the `Result<T, E>` type and utility functions in `src/types/result.ts`
    - Define `Result<T, E>` discriminated union type
    - Implement `ok()`, `err()`, `isOk()`, `isErr()`, `map()`, `flatMap()` utility functions
    - _Requirements: All (convention used by every domain module)_

  - [ ] 1.3 Define domain types and interfaces in `src/types/domain.ts`
    - Define `RoomId`, `ThreadId`, `TeamId`, `MessageId`, `UserId` branded types
    - Define `Room`, `DecisionThread`, `Message`, `ADR`, `CrossReference`, `ThreadStatus` interfaces
    - Define `OptionProposal`, `TradeoffTable`, `TradeoffChange`, `ClarifyingQuestion`, `SearchResult` interfaces
    - Define `Option` type with `summary`, `benefits`, `risks`, `complexity` fields
    - Define `ProposalResult` discriminated union (`multiple_options` | `single_option`)
    - Define `TeamMember` interface with `userId`, `email`, `role`, `status`, `invitedAt`, `invitedBy`
    - Define `TeamRole` (`admin` | `member`) and `UserStatus` (`active` | `invited` | `disabled`) types
    - Define `RoomChangeSummary` interface
    - Define `DiagramFile` interface
    - Define DynamoDB entity item interfaces (`RoomItem`, `ThreadItem`, `MessageItem`, `ADRItem`, `CrossReferenceItem`, `EmbeddingItem`, `TeamMemberItem`)
    - _Requirements: 1.1, 2.1, 3.2, 3.3, 3.4, 3.5, 5.1, 6.1, 6.4, 7.1, 7.3, 8.1, 10.8_

  - [ ]* 1.4 Write unit tests for `Result<T, E>` utilities
    - Test `ok()`, `err()`, `isOk()`, `isErr()`, `map()`, `flatMap()` with various types
    - _Requirements: All (foundational utility)_

- [ ] 2. Implement DynamoDB service layer
  - [ ] 2.1 Implement the DynamoDB service client in `src/services/dynamo.ts`
    - Create DynamoDB DocumentClient singleton configuration
    - Implement `putItem`, `getItem`, `query` functions returning `Result<T, DynamoError>`
    - Implement `putItemWithRetry` with exponential backoff (base 100ms, max 3 retries)
    - Define `DynamoError` type with `WRITE_FAILURE`, `READ_FAILURE`, `CONDITION_CHECK_FAILED`, `RETRIES_EXHAUSTED` kinds
    - _Requirements: 9.1, 9.2, 9.4, 9.5_

  - [ ]* 2.2 Write property test for retry with exponential backoff
    - **Property 21: Write retry with exponential backoff**
    - Verify that for any failure sequence, the retry mechanism attempts at most 3 retries and delay between attempt N and N+1 is ≥ baseDelay * 2^N ms
    - **Validates: Requirements 9.4**

- [ ] 3. Implement S3 and Bedrock service layers
  - [ ] 3.1 Implement the S3 service in `src/services/s3.ts`
    - Implement `uploadDocument` and `getDocument` functions returning `Result<T, S3Error>`
    - Define `S3Error` type with `UPLOAD_FAILURE`, `DOWNLOAD_FAILURE`, `NOT_FOUND` kinds
    - _Requirements: 5.5, 8.2_

  - [ ] 3.2 Implement the Bedrock service in `src/services/bedrock.ts`
    - Implement `invokeClaudeModel` for Claude reasoning calls returning `Result<string, BedrockError>`
    - Implement `generateTitanEmbedding` for embedding generation returning `Result<number[], BedrockError>`
    - Define `BedrockError` type with `INVOCATION_FAILURE`, `THROTTLED`, `VALIDATION_ERROR` kinds
    - Include retry logic for transient Bedrock failures
    - _Requirements: 3.1, 7.1, 7.4, 8.1_

- [ ] 4. Implement Room Manager domain logic
  - [ ] 4.1 Implement `src/lib/room-manager.ts`
    - Implement `validateRoomName` — reject empty, whitespace-only, and >100 char names
    - Implement `createRoom` — generate unique ID, set creation timestamp, validate name, check for duplicates, persist to DynamoDB
    - Implement `getRoom` — retrieve room with all threads, enforce team-scoped access
    - Implement `listRoomsForTeam` — query rooms by team ID
    - Define `RoomError` type with `EMPTY_NAME`, `NAME_TOO_LONG`, `DUPLICATE_NAME`, `NOT_FOUND`, `PERSISTENCE_FAILURE` kinds
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 10.3, 10.4_

  - [ ]* 4.2 Write property test for room creation invariants
    - **Property 1: Room creation invariants**
    - For any string 1-100 chars, `createRoom` produces a Room with unique non-empty ID, exact given name, valid ISO 8601 timestamp, threadCount of 0, and correct team association
    - **Validates: Requirements 1.1, 1.2**

  - [ ]* 4.3 Write property test for invalid room name rejection
    - **Property 2: Invalid room name rejection**
    - For any empty, whitespace-only, or >100 char string, `validateRoomName` returns appropriate error Result
    - **Validates: Requirements 1.5**

  - [ ]* 4.4 Write property test for team-scoped room access
    - **Property 17: Team-scoped room access**
    - For any Room associated with teamId T, user in team T gets access, user NOT in team T is denied
    - **Validates: Requirements 10.3, 10.4**

- [ ] 5. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 6. Implement Thread Lifecycle domain logic
  - [ ] 6.1 Implement `src/lib/thread-lifecycle.ts`
    - Define `VALID_TRANSITIONS` map: DRAFT→[IN_PROGRESS], IN_PROGRESS→[DECIDED], DECIDED→[IN_PROGRESS, SUPERSEDED], SUPERSEDED→[]
    - Implement `createThread` — generate unique ID, set status to DRAFT, persist to DynamoDB
    - Implement `canTransition` — check if target status is in VALID_TRANSITIONS for current status
    - Implement `transition` — validate transition, apply state change, record metadata (selected option, reopen marker, superseding thread ID), update timestamps
    - Define `ThreadError` type with `INVALID_TRANSITION`, `NOT_FOUND`, `PERSISTENCE_FAILURE` kinds
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ]* 6.2 Write property test for thread creation produces DRAFT
    - **Property 3: Thread creation produces DRAFT status**
    - For any valid Room and non-empty title, `createThread` produces a thread with DRAFT status, unique threadId, and the provided title
    - **Validates: Requirements 2.1**

  - [ ]* 6.3 Write property test for valid thread transitions
    - **Property 4: Valid thread transitions produce correct state**
    - For any thread in a given status, applying a valid transition succeeds with correct target status and updated timestamp; DRAFT→IN_PROGRESS records timestamp, IN_PROGRESS→DECIDED records selected option, DECIDED→IN_PROGRESS appends reopen marker, DECIDED→SUPERSEDED stores cross-reference
    - **Validates: Requirements 2.2, 2.3, 2.4, 2.5**

  - [ ]* 6.4 Write property test for invalid thread transitions
    - **Property 5: Invalid thread transitions are rejected**
    - For any thread with status S and target T NOT in VALID_TRANSITIONS[S], `transition` returns error with `INVALID_TRANSITION` kind containing current status, attempted target, and valid targets list
    - **Validates: Requirements 2.6**

- [ ] 7. Implement AI Architect domain logic
  - [ ] 7.1 Implement `src/lib/ai-architect.ts`
    - Implement `assessInputSufficiency` — evaluate message context against trigger criteria (scale, deployment env, team size, tech prefs), generate 1-5 clarifying questions if ambiguous, return sufficiency assessment
    - Implement `proposeOptions` — invoke Bedrock Claude, parse and validate response with Zod schema, ensure 2-5 options with required structure (summary ≤200 chars, ≥2 benefits, ≥2 risks, complexity rating)
    - Implement `proposeOptionsWithFallback` — wraps `proposeOptions` with fallback to `single_option` result when constraints are too restrictive, includes `relaxationSuggestions`
    - Implement `regenerateTradeoffTable` — re-evaluate options against new constraints, return `TradeoffChange[]` tracking exactly what changed (optionId, field, previousValue, newValue, reason)
    - Implement response validation using Zod schemas to structurally validate all AI outputs
    - Define `AIError` type with `BEDROCK_INVOCATION_FAILURE`, `RESPONSE_VALIDATION_FAILURE`, `INSUFFICIENT_CONTEXT`, `RATE_LIMITED`, `TIMEOUT` kinds
    - Define `TradeoffChange` interface for change tracking
    - Define `ProposalResult` discriminated union (`multiple_options` | `single_option`)
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4_

  - [ ]* 7.2 Write property test for option proposal structural validity
    - **Property 6: Option proposal structural validity**
    - For any OptionProposal, it contains 2-5 options, each with summary ≤200 chars, ≥2 benefits, ≥2 risks, complexity in {Low, Medium, High}, and tradeoff table has one row per option and one column per constraint
    - **Validates: Requirements 3.2, 3.3**

  - [ ]* 7.3 Write property test for clarifying questions
    - **Property 7: Clarifying questions are well-formed**
    - For any set of clarifying questions from `assessInputSufficiency`, the set contains 1-5 questions, each with a non-empty relevance explanation referencing a specific constraint or tradeoff
    - **Validates: Requirements 4.1, 4.2**

  - [ ]* 7.4 Write property test for tradeoff change tracking
    - **Property 24: Tradeoff regeneration tracks changes**
    - For any regeneration triggered by new constraints, the returned `TradeoffChange[]` contains one entry per changed field, each identifying option, field, previous value, new value, and reason
    - **Validates: Requirements 3.4**

  - [ ]* 7.5 Write property test for single-option fallback
    - **Property 28: Single-option fallback with relaxation suggestions**
    - When constraints produce only one viable option, `proposeOptionsWithFallback` returns `single_option` with valid option structure and non-empty `relaxationSuggestions`
    - **Validates: Requirements 3.5**

- [ ] 8. Implement ADR Generator domain logic
  - [ ] 8.1 Implement `src/lib/adr-generator.ts`
    - Implement `generateADR` — invoke Bedrock Claude to synthesize ADR from thread context, validate required sections (identifier, title, date, status, context, options, decision, consequences), include cross-references in "Related Decisions" section
    - Enforce 30-second timeout (`ADR_GENERATION_TIMEOUT_MS = 30_000`) — cancel and retry on timeout
    - Implement `exportADRToS3` — upload structured ADR document to S3 bucket
    - Implement ADR sequential ID generation (ADR-001, ADR-002, etc.) using GSI3
    - Handle insufficient context — return error listing missing sections
    - Handle generation failure — retry up to 3 times (including timeout retries)
    - Define `ADRError` type with `INSUFFICIENT_CONTEXT`, `GENERATION_FAILURE`, `S3_UPLOAD_FAILURE`, `TIMEOUT` kinds
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_

  - [ ]* 8.2 Write property test for ADR required sections
    - **Property 8: ADR contains all required sections**
    - For any ADR generated from a decided thread, it contains: sequential identifier matching `ADR-NNN`, non-empty title, valid date, status ACTIVE, non-empty context, ≥2 options considered, non-empty decision, non-empty consequences
    - **Validates: Requirements 5.1**

  - [ ]* 8.3 Write property test for ADR cross-references
    - **Property 9: ADR includes cross-references when present**
    - For any thread with ≥1 CrossReferences, the generated ADR includes a "Related Decisions" section listing every referenced ADR by identifier and title
    - **Validates: Requirements 5.3**

  - [ ]* 8.4 Write property test for ADR supersession
    - **Property 10: ADR supersession updates status correctly**
    - For any ADR with ACTIVE status, when thread is superseded, ADR status updates to SUPERSEDED with reference to superseding ADR identifier
    - **Validates: Requirements 5.4**

  - [ ]* 8.5 Write property test for insufficient context error
    - **Property 11: Insufficient context ADR error enumerates missing sections**
    - For any thread missing required ADR sections, generation returns error with `INSUFFICIENT_CONTEXT` kind and `missingSections` array listing exactly those sections lacking information
    - **Validates: Requirements 5.6**

  - [ ]* 8.6 Write property test for ADR generation timeout
    - **Property 22: ADR generation completes within timeout**
    - For any thread transitioning to DECIDED, `generateADR` either returns within 30,000ms or returns a timeout error; on timeout, retries up to 3 times
    - **Validates: Requirements 5.2**

- [ ] 9. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 10. Implement Cross-Reference Engine
  - [ ] 10.1 Implement `src/lib/cross-reference.ts`
    - Implement `createCrossReference` — validate no self-reference, verify target exists, persist to DynamoDB
    - Implement `findRelatedDecisions` — compute cosine similarity between query embedding and stored embeddings, return matches above threshold with relevance descriptions
    - Implement `summarizeChangesSince` — query room for ADRs created after given date, threads referencing focus thread, and threads that transitioned to SUPERSEDED; return `RoomChangeSummary`
    - Implement `getReferencesForThread` — query all cross-references for a thread
    - Define `CrossRefError` type, `ReferenceType` union, and `RoomChangeSummary` interface
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_

  - [ ]* 10.2 Write property test for room change summary completeness
    - **Property 26: Room change summary completeness**
    - For any room and date D, `summarizeChangesSince` returns all ADRs created after D, all threads referencing the focus thread, and all superseded threads; `totalChanges` equals the sum of all arrays' lengths
    - **Validates: Requirements 6.4**

- [ ] 11. Implement Decision Journal (Search)
  - [ ] 11.1 Implement `src/lib/decision-journal.ts`
    - Implement `semanticSearch` — reject empty/whitespace queries, generate query embedding via Titan, compute cosine similarity against stored embeddings, apply structured filters (status, date range, title), return up to 50 results ranked by similarity with minimum threshold 0.7
    - Enforce 2-second timeout (`SEARCH_TIMEOUT_MS = 2_000`) — cancel operation on timeout, return `TIMEOUT` error
    - Implement `generateEmbedding` — wrapper around Bedrock Titan embedding service
    - Implement `indexEntity` — generate Titan embedding for thread/ADR content, upsert to DynamoDB with `EMB#{entityType}#{entityId}` key, store ≤200 char summary; called on create/update of threads and ADRs
    - Implement `cosineSimilarity` — compute cosine similarity between two equal-dimension vectors
    - Define `SearchError` type with `EMPTY_QUERY`, `EMBEDDING_FAILURE`, `QUERY_FAILURE`, `TIMEOUT` kinds
    - _Requirements: 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

  - [ ]* 11.2 Write property test for semantic search ranking and bounds
    - **Property 12: Semantic search results are ranked by similarity and bounded**
    - For any set of embeddings and query, results are in descending similarity order, contain at most 50 results, all with scores ≥ 0.7
    - **Validates: Requirements 7.1, 7.5**

  - [ ]* 11.3 Write property test for structured filter intersection
    - **Property 13: Structured filters intersect correctly with results**
    - For any combination of filters, every result satisfies ALL applied criteria simultaneously; results not matching any filter are excluded
    - **Validates: Requirements 7.2**

  - [ ]* 11.4 Write property test for search result structure
    - **Property 14: Search result structure completeness**
    - For any search result, it includes: non-empty title, valid ThreadStatus, valid date, numeric similarity score between 0 and 1, and text summary ≤200 characters
    - **Validates: Requirements 7.3**

  - [ ]* 11.5 Write property test for empty query rejection
    - **Property 15: Empty/whitespace search query rejection**
    - For any empty or whitespace-only string, `semanticSearch` returns error with `EMPTY_QUERY` kind without executing embedding generation
    - **Validates: Requirements 7.6**

  - [ ]* 11.6 Write property test for cosine similarity properties
    - **Property 16: Cosine similarity is symmetric and bounded**
    - For any two equal-dimension vectors, `cosineSimilarity(a, b)` equals `cosineSimilarity(b, a)` and result is in [-1, 1]
    - **Validates: Requirements 7.1**

  - [ ]* 11.7 Write property test for search timeout
    - **Property 23: Search completes within timeout**
    - For any valid search query, `semanticSearch` either returns within 2,000ms or returns a timeout error; operation is cancelled on timeout
    - **Validates: Requirements 7.1**

  - [ ]* 11.8 Write property test for embedding indexing on write
    - **Property 27: Embedding indexing on entity write**
    - For any thread/ADR created or updated, `indexEntity` generates a 1536-dim embedding, persists it with correct keys, and it is retrievable by `semanticSearch` immediately after
    - **Validates: Requirements 7.4**

- [ ] 12. Implement Diagram Generator
  - [ ] 12.1 Implement `src/lib/diagram-generator.ts`
    - Implement `isInfrastructureDecision` — determine if thread involves infrastructure (cloud, networking, deployment, containers, databases, storage, messaging, compute)
    - Implement `generateDecisionDiagram` — invoke Bedrock Claude to produce .drawio XML for a decided thread showing system components, connections, and data flow direction
    - Implement `generateOptionComparisonDiagram` — produce .drawio XML showing each option as a separate labeled section during deliberation
    - Implement `uploadDiagram` — upload .drawio file to S3 and return object key + file name
    - Define `DiagramError` type with `GENERATION_FAILURE`, `S3_UPLOAD_FAILURE`, `NOT_INFRASTRUCTURE` kinds
    - Define `DiagramFile` interface with fileName, content (XML), components, and connections
    - Handle failure gracefully — notify user without blocking thread DECIDED transition
    - _Requirements: 8.1, 8.2, 8.3, 8.4_

  - [ ]* 12.2 Write property test for diagram generation
    - **Property 29: Diagram generation for infrastructure decisions**
    - For any DECIDED thread where `isInfrastructureDecision` is true, `generateDecisionDiagram` produces a DiagramFile with valid .drawio XML, ≥1 component, ≥1 connection with data flow, and non-empty fileName
    - **Validates: Requirements 8.1, 8.2**

  - [ ]* 12.3 Write property test for option comparison diagram
    - **Property 30: Option comparison diagram during deliberation**
    - For any 2-5 options in an IN_PROGRESS thread, `generateOptionComparisonDiagram` produces a DiagramFile where each option appears as a separately labeled section with its components and connections
    - **Validates: Requirements 8.3**

- [ ] 13. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 14. Implement Authentication and Team Management
  - [ ] 14.1 Implement `src/services/cognito.ts` and API Gateway authorization
    - Implement Cognito JWT token validation
    - Implement team group membership checking
    - Implement middleware/authorizer that validates access tokens and extracts team claims
    - Attach user identity (`userId`) to all created entities (messages, threads, ADRs)
    - Handle expired/invalid tokens — return 401 and trigger frontend redirect
    - Configure Cognito User Pool with `selfSignUpEnabled: false` and `allowAdminCreateUserOnly: true`
    - _Requirements: 10.1, 10.3, 10.4, 10.5, 10.6, 10.7_

  - [ ] 14.2 Implement `src/lib/team-management.ts`
    - Implement `inviteUser` — create Cognito user via AdminCreateUser, assign to team group, store role in DynamoDB TeamMemberItem, send invitation email with temporary password
    - Implement `removeUser` — remove from Cognito group, revoke room access, mark as disabled in DynamoDB
    - Implement `changeRole` — update role between admin and member, enforce cannot-remove-last-admin guard
    - Implement `listTeamMembers` — query DynamoDB for all MEMBER# items in team, return with email/role/status
    - Implement `isTeamAdmin` — check if user has admin role for given team
    - Define `TeamManagementError` type with `NOT_ADMIN`, `USER_ALREADY_EXISTS`, `USER_NOT_FOUND`, `CANNOT_REMOVE_LAST_ADMIN`, `COGNITO_FAILURE`, `PERSISTENCE_FAILURE` kinds
    - _Requirements: 10.2, 10.5, 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [ ]* 14.3 Write property test for user identity attribution
    - **Property 20: User identity attribution**
    - For any entity created by a user, the entity stores the creating user's Cognito identity in a non-empty `createdBy` or `sender` field
    - **Validates: Requirements 10.7**

  - [ ]* 14.4 Write property test for admin-only team management
    - **Property 18: Admin-only team management**
    - For any user attempting admin operations: admins succeed, non-admins receive `NOT_ADMIN` error
    - **Validates: Requirements 10.12, 10.13**

  - [ ]* 14.5 Write property test for cannot remove last admin
    - **Property 19: Cannot remove last admin**
    - For any team with exactly one admin, removing or demoting that admin returns `CANNOT_REMOVE_LAST_ADMIN` error
    - **Validates: Requirements 10.10, 10.11**

- [ ] 15. Implement AWS CDK Infrastructure
  - [ ] 15.1 Implement `infra/lib/chalk-stack.ts` CDK stack
    - Define DynamoDB table with single-table design (PK, SK, GSI1, GSI2, GSI3 as specified in design)
    - Define S3 bucket for diagrams and ADR exports
    - Define Cognito User Pool with `selfSignUpEnabled: false`, `allowAdminCreateUserOnly: true`, email verification, invitation email template, and team groups
    - Define API Gateway HTTP API with Cognito authorizer
    - Define Lambda functions for each domain operation (room, thread, AI, ADR, search, diagram, team management)
    - Configure IAM permissions: Lambda → DynamoDB, Lambda → Bedrock, Lambda → S3, Lambda → Cognito (AdminCreateUser, AdminAddUserToGroup, AdminRemoveUserFromGroup)
    - _Requirements: 1.1, 9.1, 10.1, 10.2, 10.9 (infrastructure for all requirements)_

- [ ] 16. Implement Lambda API handlers
  - [ ] 16.1 Implement Lambda handlers for Room and Thread operations
    - `POST /rooms` — create room (validate name, team-scoped)
    - `GET /rooms` — list rooms for team
    - `GET /rooms/:id` — get room with threads
    - `POST /rooms/:id/threads` — create thread
    - `POST /threads/:id/transition` — transition thread status
    - Apply write-before-acknowledge pattern for all mutations
    - Map domain errors to appropriate HTTP status codes (400, 401, 403, 404, 503)
    - _Requirements: 1.1, 1.3, 1.4, 1.5, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6_

  - [ ] 16.2 Implement Lambda handlers for messaging and AI interactions
    - `POST /threads/:id/messages` — persist user message, invoke AI Architect, persist AI response, return both
    - Wire `assessInputSufficiency` for first messages — generate clarifying questions if needed
    - Wire `proposeOptionsWithFallback` when context is sufficient
    - Wire `regenerateTradeoffTable` when new constraints arrive
    - Ensure messages are persisted before acknowledgement (write-before-ack)
    - Call `indexEntity` after thread message updates to keep embeddings fresh
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 4.1, 4.2, 4.3, 4.4, 9.2, 9.3_

  - [ ] 16.3 Implement Lambda handlers for ADR, search, and diagram operations
    - `POST /threads/:id/decide` — transition to DECIDED, trigger ADR generation (with 30s timeout) and S3 export, generate diagram if infrastructure decision
    - `GET /rooms/:id/adrs` — list ADRs in room
    - `POST /rooms/:id/search` — semantic search with optional filters (2s timeout)
    - `POST /threads/:id/diagram` — generate comparison diagram during deliberation, upload to S3
    - Wire cross-reference engine into thread creation and ADR generation flows
    - Wire `summarizeChangesSince` when a DECIDED thread is reopened
    - Call `indexEntity` on ADR creation/update to keep embeddings fresh
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 7.1, 7.2, 7.3, 7.4, 8.1, 8.2, 8.3_

  - [ ] 16.4 Implement Lambda handlers for team management
    - `GET /teams/:id/members` — list team members (admin only)
    - `POST /teams/:id/members` — invite user with email and role (admin only)
    - `DELETE /teams/:id/members/:userId` — remove user from team (admin only)
    - `PATCH /teams/:id/members/:userId` — change user role (admin only)
    - Enforce admin-only access via `isTeamAdmin` check before processing
    - _Requirements: 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_

  - [ ]* 16.5 Write property test for persist-before-acknowledge
    - **Property 25: Persist-before-acknowledge ordering**
    - For any message sent, the Lambda handler confirms DynamoDB persistence before returning success; on write failure (after retries), returns error and client does not display message as sent
    - **Validates: Requirements 9.2**

- [ ] 17. Checkpoint
  - Ensure all tests pass, ask the user if questions arise.

- [ ] 18. Implement Frontend — Room and Thread UI
  - [ ] 18.1 Implement Room list page and Room creation form in `src/app/` and `src/components/`
    - Create `/rooms` page listing all rooms for the user's team with SWR data fetching
    - Create Room creation form with name validation (1-100 chars, no duplicates)
    - Display thread list within a room showing Thread_Status and creation date
    - _Requirements: 1.1, 1.2, 1.3, 1.5_

  - [ ] 18.2 Implement Decision Thread conversation UI
    - Create thread view page showing messages in chronological order
    - Implement message input with send functionality
    - Display AI Architect responses with structured data (options, tradeoff tables, clarifying questions)
    - Display thread status badge and valid transition actions
    - Implement option approval flow (select option → confirm → transition to DECIDED)
    - Display reopen markers and supersession notices
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 4.1, 4.2, 4.3_

- [ ] 19. Implement Frontend — ADR, Search, Team Management, and Auth UI
  - [ ] 19.1 Implement ADR display and Decision Journal search UI
    - Create ADR view component showing all sections (context, options, decision, consequences, related decisions, diagrams)
    - Implement search page with query input and structured filters (status, date range, title)
    - Display search results with title, status, date, similarity score, and summary
    - Show "no results" message when similarity threshold not met
    - _Requirements: 5.1, 5.3, 7.1, 7.2, 7.3, 7.5, 7.6_

  - [ ] 19.2 Implement authentication flow in the frontend
    - Integrate Cognito hosted UI or custom sign-in page (no self sign-up — admin invitation only)
    - Implement token refresh and expiry handling (redirect to sign-in on 401)
    - Pass access token in API requests via Authorization header
    - Implement SWR error handling with retry banner for persistence failures
    - Store pending messages in localStorage on failure for later sync
    - _Requirements: 10.1, 10.5, 10.6, 9.4, 9.5_

  - [ ] 19.3 Implement Team Management page (admin-only)
    - Create `/team` page accessible only to users with admin role
    - Display list of all team members with email, role (admin/member), and status (active/invited/disabled)
    - Implement "Invite User" form — email input and role selector (admin or member)
    - Implement "Remove User" action with confirmation dialog
    - Implement role change (promote to admin / demote to member) with confirmation
    - Show non-admin users an unauthorized message if they attempt to access the page
    - _Requirements: 10.8, 10.9, 10.10, 10.11, 10.12, 10.13_

- [ ] 20. Final checkpoint
  - Ensure all tests pass, ask the user if questions arise.

## Notes

- Tasks marked with `*` are optional and can be skipped for faster MVP
- Each task references specific requirements for traceability
- Checkpoints ensure incremental validation
- Property tests validate universal correctness properties from the design document
- Unit tests validate specific examples and edge cases
- The `Result<T, E>` pattern is used throughout — no thrown exceptions in domain logic
- Write-before-acknowledge is enforced for all message persistence
- All AI responses are structurally validated with Zod before presenting to users

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4", "2.1", "3.1", "3.2"] },
    { "id": 3, "tasks": ["2.2", "4.1", "6.1"] },
    { "id": 4, "tasks": ["4.2", "4.3", "4.4", "6.2", "6.3", "6.4", "7.1"] },
    { "id": 5, "tasks": ["7.2", "7.3", "7.4", "7.5", "8.1"] },
    { "id": 6, "tasks": ["8.2", "8.3", "8.4", "8.5", "8.6", "10.1", "11.1"] },
    { "id": 7, "tasks": ["10.2", "11.2", "11.3", "11.4", "11.5", "11.6", "11.7", "11.8", "12.1"] },
    { "id": 8, "tasks": ["12.2", "12.3", "14.1", "14.2", "15.1"] },
    { "id": 9, "tasks": ["14.3", "14.4", "14.5", "16.1"] },
    { "id": 10, "tasks": ["16.2", "16.3", "16.4", "16.5"] },
    { "id": 11, "tasks": ["18.1", "19.1"] },
    { "id": 12, "tasks": ["18.2", "19.2", "19.3"] }
  ]
}
```
