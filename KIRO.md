# Built with Kiro — Agentic Development Explanation

Chalk was built entirely using Kiro's spec-driven development workflow. Rather than writing code manually, I described what I wanted to build and let Kiro orchestrate the entire implementation through a structured process.

## How It Worked

I started with a rough idea: a workspace where humans describe constraints, an AI "Architect" agent proposes options with tradeoffs, generates comparison tables, and produces ADRs. The key insight was that it shouldn't be a one-shot tool but a living decision journal teams return to throughout a project, with the AI connecting decisions to each other over time. Kiro guided me through a requirements-first workflow, generating detailed requirements with acceptance criteria, a technical design document with component interfaces and data models, and finally a task list with a dependency graph for parallel execution.

The task execution phase is where Kiro's agentic capabilities shone. Kiro's orchestrator dispatched up to 5 implementation tasks in parallel, each handled by a specialized sub-agent that wrote code, ran tests, and verified compilation. The wave-based dependency graph meant independent modules (DynamoDB service, S3 service, Bedrock service) were built simultaneously, while dependent modules (domain logic requiring those services) waited until prerequisites completed.

Property-based testing was baked into the workflow from the start. The design document defined 28 formal correctness properties (e.g., "for any thread with status S and invalid target T, transition returns INVALID_TRANSITION error"). Kiro generated fast-check test suites that verify these properties hold across hundreds of random inputs, and one even caught a floating-point precision bug in the cosine similarity function during execution.

The entire project (76 tasks spanning types, services, domain logic, Lambda handlers, CDK infrastructure, property tests, and a full React frontend) was implemented in a single session with Kiro autonomously managing the build order, parallelism, and verification.

## What Made It Effective

- **Spec-first**: Requirements and design were locked before any code was written, eliminating rework
- **Parallel execution**: Wave-based task scheduling cut wall-clock time significantly
- **Property testing**: Formal correctness properties caught edge cases that example-based tests would miss
- **Result<T, E> convention**: Kiro enforced the no-exceptions pattern consistently across 15+ modules
- **Automated verification**: Each sub-agent ran `tsc --noEmit` and `vitest run` before reporting completion
