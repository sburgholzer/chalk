# TODO

## Known Issues

- [ ] Messages are stored in React state only; navigating away from the thread loses the conversation history. Need a `GET /threads/{threadId}/messages` endpoint and frontend integration.
- [ ] ADR generation happens on the backend but there's no frontend page to view generated ADRs. The `GET /rooms/{roomId}/adrs` endpoint exists but needs a UI.
- [ ] The "Start Discussion" button on DECIDED threads shows incorrectly (should show "Reopen" label instead). ThreadStatusBar transition labels need refinement.
- [ ] No favicon (404 on `/favicon.ico`)

## Auth Improvements

- [ ] Add JWKS signature verification back to Lambda handlers (currently decodes JWT without cryptographic validation)
- [ ] Add refresh token handling in the frontend (currently only access token is used)
- [ ] Add API Gateway Cognito authorizer back once token format issues are resolved

## Frontend

- [ ] Add ADR view page (`/rooms/{roomId}/adrs/{adrId}`)
- [ ] Add semantic search page link from room detail
- [ ] Persist messages by fetching from DynamoDB on thread page load
- [ ] Add loading spinner during AI response (currently just "Sending..." disabled state)
- [ ] Add navigation between threads without losing context

## Backend

- [ ] Add `GET /threads/{threadId}/messages` Lambda endpoint for message history retrieval
- [ ] Add Amplify hosting to CDK stack for production frontend deployment
- [ ] Add CloudWatch alarms for Lambda errors and Bedrock throttling
- [ ] Tighten Bedrock IAM policy to specific model ARNs instead of `*`

## Testing

- [ ] Add integration tests that hit the deployed API with real Cognito tokens
- [ ] Add E2E tests with Playwright for the full UI flow
