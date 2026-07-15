# Chalk - Architecture Decision Room

A collaborative workspace where humans and an AI Architect agent team up to make technical architecture decisions and produce Architecture Decision Records (ADRs).

**[Demo Video](https://youtu.be/OiMlzbdsEcE)**

---

## What It Does

Teams describe constraints and requirements in a shared decision room. The AI Architect agent asks clarifying questions, proposes architecture options with tradeoff tables, and generates ADRs when decisions are finalized.

### Collaboration Signals Demonstrated

| Signal | How |
|--------|-----|
| Human adds idea into shared workspace | User types constraints into a decision thread |
| Agent responds using workspace context | AI asks clarifying questions based on stated constraints |
| Agent creates shared artifact | AI generates option proposals with tradeoff comparison table |
| User approves agent contribution | User selects an option and marks thread as Decided |
| Two or more roles in workflow | Human architect + AI Architect agent |
| Visible history of contributions | Message thread shows chronological human/AI exchange |

---

## Agent Role: AI Architect

The AI Architect (Amazon Bedrock / Claude Sonnet 4) participates as a team member:

1. Asks 1-5 clarifying questions when constraints are ambiguous
2. Proposes 2-5 distinct options with benefits, risks, and complexity ratings
3. Generates a tradeoff comparison table against stated constraints
4. Generates structured ADRs when a decision is finalized
5. Produces .drawio architecture diagrams for infrastructure decisions

---

## Setup

### 1. Deploy the backend

```bash
cd infra
npm install
npx cdk deploy
```

CDK outputs the values needed for step 2:

```
ChalkStack.ApiUrl = https://xxxxx.execute-api.us-east-1.amazonaws.com
ChalkStack.CognitoDomain = https://chalk-app.auth.us-east-1.amazoncognito.com
ChalkStack.UserPoolClientId = xxxxxxxxxxxxxxxxxxxxxxxxxx
ChalkStack.DefaultTeamId = chalk-team
ChalkStack.BucketName = chalkstack-chalkbucket-xxxxx
ChalkStack.UserPoolId = us-east-1_XXXXXXXXX
ChalkStack.TableName = ChalkTable
```

### 2. Create a user

```bash
aws cognito-idp admin-create-user \
  --user-pool-id <UserPoolId> \
  --username "your@email.com" \
  --user-attributes Name=email,Value="your@email.com" Name=email_verified,Value=true \
  --desired-delivery-mediums EMAIL \
  --region us-east-1

aws cognito-idp admin-add-user-to-group \
  --user-pool-id <UserPoolId> \
  --username "your@email.com" \
  --group-name "chalk-team" \
  --region us-east-1
```

Check your email for the temporary password.

### 3. Configure local environment

```bash
cp .env.example .env.local
```

Fill in `NEXT_PUBLIC_*` values from CDK outputs. See [.env.example](.env.example) for details.

### 4. Run locally

```bash
cd chalk              # project root (where package.json lives)
npm install
npm run dev           # http://localhost:3000
```

### 5. Run tests

```bash
npm test              # Unit + property-based tests
```

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14, React, Tailwind CSS, SWR |
| AI | Amazon Bedrock (Claude Sonnet 4 + Titan Embeddings) |
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

See [KIRO.md](KIRO.md) for how agentic development shaped this project.

---

## License

MIT
