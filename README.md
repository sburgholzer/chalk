# Chalk - Architecture Decision Room

A collaborative workspace where humans and an AI Architect agent team up to make technical architecture decisions and produce Architecture Decision Records (ADRs).

**[▶ Demo Video (60s)](https://your-demo-link-here.com)** <!-- Replace with actual link -->

---

## What It Does

Teams describe constraints and requirements in a shared decision room. The AI Architect agent asks clarifying questions, proposes 2–5 architecture options with tradeoff tables, and generates ADRs when decisions are finalized. All decisions are cross-referenced and semantically searchable.

### Collaboration Signals

| Signal | How Chalk Demonstrates It |
|--------|--------------------------|
| **Shared workspace** | Rooms hold threads visible to all team members |
| **Role-based contributions** | Human architects set constraints; AI Architect proposes options and generates ADRs |
| **Structured negotiation** | Tradeoff tables compare options against stated constraints |
| **Iterative refinement** | Adding new constraints regenerates the analysis with change tracking |
| **Persistent decision history** | ADRs cross-reference prior decisions; semantic search across all history |

---

## Agent Role: AI Architect

The AI Architect (powered by Amazon Bedrock / Claude) participates as a team member that:

1. Assesses input sufficiency and asks 1–5 clarifying questions when context is ambiguous
2. Proposes 2–5 distinct options with benefits, risks, complexity ratings, and a tradeoff comparison table
3. Regenerates analysis when constraints change, tracking exactly what shifted
4. Generates structured ADRs with cross-references to prior decisions
5. Produces `.drawio` architecture diagrams for infrastructure decisions

---

## Setup

### 1. Deploy the backend

```bash
cd infra
npm install
npx cdk deploy
```

CDK will output values you need for the next step:

```
Outputs:
  ChalkStack.ApiUrl = https://xxxxx.execute-api.us-east-1.amazonaws.com
  ChalkStack.UserPoolId = us-east-1_XXXXXXXXX
  ChalkStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
  ChalkStack.BucketName = chalkstack-chalkbucket-xxxxx
  ChalkStack.TableName = ChalkTable
```

### 2. Configure local environment

```bash
cp .env.example .env.local
```

Fill in the `NEXT_PUBLIC_*` values using the CDK outputs:

```env
NEXT_PUBLIC_API_URL=<ApiUrl from CDK output>
NEXT_PUBLIC_COGNITO_DOMAIN=<your Cognito hosted UI domain>
NEXT_PUBLIC_COGNITO_CLIENT_ID=<UserPoolClientId from CDK output>
NEXT_PUBLIC_REDIRECT_URI=http://localhost:3000/login
NEXT_PUBLIC_TEAM_ID=<your Cognito group name>
```

The remaining vars in `.env.example` (Lambda runtime section) are injected automatically by CDK into your Lambda functions. You only need them locally if running services directly against AWS from your machine.

### 3. Run locally

```bash
npm install
npm run dev       # http://localhost:3000
```

### 4. Run tests

```bash
npm test          # All unit + property tests
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React, Tailwind CSS, SWR |
| AI | Amazon Bedrock (Claude + Titan Embeddings) |
| Auth | Amazon Cognito (admin-only invitations) |
| API | AWS Lambda + API Gateway |
| Database | Amazon DynamoDB (single-table design) |
| Storage | Amazon S3 (diagrams, ADR exports) |
| IaC | AWS CDK (TypeScript) |

---

## Project Structure

```
src/
  app/            # Next.js App Router pages
  components/     # React components
  lib/            # Domain logic (Result<T,E> pattern, no thrown exceptions)
  services/       # AWS service integrations (Bedrock, DynamoDB, S3, Cognito)
  lambda/         # Lambda handlers for API routes
  types/          # TypeScript interfaces and branded types
infra/            # AWS CDK stack definition
```

---

## Built with Kiro

See [`KIRO.md`](KIRO.md) for how agentic development shaped this project.

---

## License

MIT
