---
inclusion: always
---

# Chalk Coding Standards

## Tech Stack
- **Runtime**: Node.js with TypeScript (strict mode)
- **Framework**: Next.js 14 with App Router
- **UI**: React with Tailwind CSS
- **AI**: Amazon Bedrock (Claude) via AWS SDK for AI Architect agent
- **Database**: Amazon DynamoDB for persistence (rooms, threads, messages, ADRs)
- **Search**: Amazon OpenSearch Serverless for full-text decision journal search
- **Storage**: Amazon S3 for diagram artifacts and exported ADR documents
- **Auth**: Amazon Cognito for user authentication and team-based authorization
- **Compute**: AWS Lambda + API Gateway for backend APIs
- **Frontend Hosting**: AWS Amplify for Next.js deployment
- **IaC**: AWS CDK (TypeScript) for infrastructure definitions
- **State**: React Context + SWR for client-side data fetching

## Project Structure
```
src/
  app/              # Next.js app router pages and API routes
  components/       # React components
  lib/              # Core business logic (domain layer)
    room-manager.ts
    thread-lifecycle.ts
    ai-architect.ts
    adr-generator.ts
    cross-reference.ts
    decision-journal.ts
  services/         # AWS service integrations
    bedrock.ts      # Amazon Bedrock client for Claude
    dynamo.ts       # DynamoDB document client
    opensearch.ts   # OpenSearch Serverless client
    s3.ts           # S3 operations for diagrams/ADRs
    cognito.ts      # Cognito auth helpers
  types/            # TypeScript interfaces and type definitions
infra/              # AWS CDK infrastructure definitions
  lib/
    chalk-stack.ts  # Main CDK stack
```

## Conventions
- Use named exports over default exports
- Prefer `Result<T, E>` pattern for operations that can fail (no thrown exceptions in domain logic)
- All AI responses must be structurally validated before presenting to users
- Thread lifecycle transitions go through the state machine — never set status directly
- Messages are persisted before being acknowledged to the client
- Keep components under 150 lines; extract sub-components when needed
- Use `'use client'` directive only on components that need interactivity

## Agent Behavior
- The AI Architect agent always identifies itself with `sender: "ai_architect"`
- Agent responses include structured data (options, tradeoff tables) alongside natural language
- The agent references prior ADRs by identifier (e.g., "ADR-001") when cross-referencing
- Agent errors are surfaced to users with clear context, never silent failures
