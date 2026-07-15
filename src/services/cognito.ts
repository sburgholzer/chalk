import {
  CognitoIdentityProviderClient,
  AdminCreateUserCommand,
  AdminAddUserToGroupCommand,
  AdminRemoveUserFromGroupCommand,
  AdminListGroupsForUserCommand,
  AdminGetUserCommand,
  CreateGroupCommand,
} from '@aws-sdk/client-cognito-identity-provider';
import { type Result, ok, err } from '@/types/result';
import type { UserId, TeamId } from '@/types/domain';

// =============================================================================
// Types
// =============================================================================

/** Error types for Cognito service operations. */
export type CognitoError =
  | { kind: 'TOKEN_EXPIRED'; message: string }
  | { kind: 'TOKEN_INVALID'; message: string }
  | { kind: 'USER_NOT_FOUND'; userId: string }
  | { kind: 'GROUP_NOT_FOUND'; groupName: string }
  | { kind: 'SERVICE_FAILURE'; cause: string };

/** Represents a decoded and validated Cognito user identity. */
export interface CognitoUser {
  userId: UserId;
  email: string;
  teams: TeamId[];
  tokenExpiry: number; // Unix timestamp (seconds)
}

/** Decoded JWT token payload from Cognito. */
export interface CognitoTokenPayload {
  sub: string;
  email?: string;
  'cognito:groups'?: string[];
  'cognito:username'?: string;
  token_use: 'access' | 'id';
  exp: number;
  iat: number;
  iss: string;
  client_id?: string;
}

// =============================================================================
// Configuration
// =============================================================================

function getUserPoolId(): string {
  return process.env.COGNITO_USER_POOL_ID ?? '';
}

function getClientId(): string {
  return process.env.COGNITO_CLIENT_ID ?? '';
}

function getRegion(): string {
  return process.env.COGNITO_REGION ?? process.env.AWS_REGION ?? 'us-east-1';
}

let clientInstance: CognitoIdentityProviderClient | null = null;

function getClient(): CognitoIdentityProviderClient {
  if (!clientInstance) {
    clientInstance = new CognitoIdentityProviderClient({ region: getRegion() });
  }
  return clientInstance;
}

// =============================================================================
// JWKS Cache for Token Validation
// =============================================================================

interface JWK {
  kid: string;
  alg: string;
  kty: string;
  e: string;
  n: string;
  use: string;
}

interface JWKSCache {
  keys: JWK[];
  fetchedAt: number;
}

let jwksCache: JWKSCache | null = null;
const JWKS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

/**
 * Fetches the JWKS (JSON Web Key Set) from the Cognito User Pool.
 * Results are cached for 1 hour.
 */
async function getJWKS(): Promise<Result<JWK[], CognitoError>> {
  const now = Date.now();
  if (jwksCache && now - jwksCache.fetchedAt < JWKS_CACHE_TTL_MS) {
    return ok(jwksCache.keys);
  }

  const jwksUrl = `https://cognito-idp.${getRegion()}.amazonaws.com/${getUserPoolId()}/.well-known/jwks.json`;

  try {
    const response = await fetch(jwksUrl);
    if (!response.ok) {
      return err({
        kind: 'SERVICE_FAILURE',
        cause: `Failed to fetch JWKS: HTTP ${response.status}`,
      });
    }

    const data = (await response.json()) as { keys: JWK[] };
    jwksCache = { keys: data.keys, fetchedAt: now };
    return ok(data.keys);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown JWKS fetch error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

// =============================================================================
// Token Validation
// =============================================================================

/**
 * Decodes a JWT token without verifying the signature (for payload inspection).
 * Returns the decoded payload or an error.
 */
function decodeTokenPayload(token: string): Result<CognitoTokenPayload, CognitoError> {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) {
      return err({ kind: 'TOKEN_INVALID', message: 'Token does not have 3 parts' });
    }

    // Decode the payload (second part)
    const payload = JSON.parse(
      Buffer.from(parts[1], 'base64url').toString('utf-8')
    ) as CognitoTokenPayload;

    return ok(payload);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to decode token';
    return err({ kind: 'TOKEN_INVALID', message });
  }
}

/**
 * Validates a Cognito access token.
 *
 * Checks:
 * 1. Token structure (3 parts, valid base64url)
 * 2. Token expiration
 * 3. Token issuer matches configured User Pool
 * 4. Token use is 'access'
 * 5. JWKS key existence (kid match)
 *
 * Returns the decoded CognitoUser or an error.
 */
export async function validateToken(token: string): Promise<Result<CognitoUser, CognitoError>> {
  // Decode the payload
  const decodeResult = decodeTokenPayload(token);
  if (!decodeResult.ok) {
    return decodeResult;
  }

  const payload = decodeResult.value;

  // Check expiration
  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) {
    return err({
      kind: 'TOKEN_EXPIRED',
      message: `Token expired at ${new Date(payload.exp * 1000).toISOString()}`,
    });
  }

  // Validate issuer
  const expectedIssuer = `https://cognito-idp.${getRegion()}.amazonaws.com/${getUserPoolId()}`;
  if (payload.iss !== expectedIssuer) {
    return err({
      kind: 'TOKEN_INVALID',
      message: `Invalid issuer: expected ${expectedIssuer}, got ${payload.iss}`,
    });
  }

  // Validate token_use
  if (payload.token_use !== 'access') {
    return err({
      kind: 'TOKEN_INVALID',
      message: `Invalid token_use: expected 'access', got '${payload.token_use}'`,
    });
  }

  // Verify the kid exists in the JWKS
  const headerResult = decodeTokenHeader(token);
  if (!headerResult.ok) {
    return headerResult;
  }

  const jwksResult = await getJWKS();
  if (!jwksResult.ok) {
    return jwksResult;
  }

  const matchingKey = jwksResult.value.find((key) => key.kid === headerResult.value.kid);
  if (!matchingKey) {
    return err({
      kind: 'TOKEN_INVALID',
      message: `No matching key found for kid: ${headerResult.value.kid}`,
    });
  }

  // Extract user identity
  const userId = (payload.sub ?? payload['cognito:username'] ?? '') as UserId;
  const email = payload.email ?? '';
  const teams = (payload['cognito:groups'] ?? []) as TeamId[];

  return ok({
    userId,
    email,
    teams,
    tokenExpiry: payload.exp,
  });
}

/**
 * Decodes the JWT header to get the key ID (kid).
 */
function decodeTokenHeader(token: string): Result<{ kid: string; alg: string }, CognitoError> {
  try {
    const parts = token.split('.');
    const header = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf-8')
    ) as { kid: string; alg: string };

    if (!header.kid) {
      return err({ kind: 'TOKEN_INVALID', message: 'Token header missing kid' });
    }

    return ok(header);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Failed to decode token header';
    return err({ kind: 'TOKEN_INVALID', message });
  }
}

// =============================================================================
// User Identity Extraction
// =============================================================================

/**
 * Extracts user identity from an Authorization header value.
 * Expects "Bearer <token>" format.
 * Returns 401-appropriate error for expired/invalid tokens.
 */
export async function extractUserIdentity(
  authorizationHeader: string | undefined
): Promise<Result<CognitoUser, CognitoError>> {
  if (!authorizationHeader) {
    return err({ kind: 'TOKEN_INVALID', message: 'Missing Authorization header' });
  }

  const parts = authorizationHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return err({ kind: 'TOKEN_INVALID', message: 'Authorization header must be Bearer <token>' });
  }

  const token = parts[1];
  return validateToken(token);
}

// =============================================================================
// Team Group Membership
// =============================================================================

/**
 * Gets the teams (Cognito groups) a user belongs to.
 * Queries the Cognito User Pool directly for authoritative group membership.
 */
export async function getUserTeams(userId: string): Promise<Result<TeamId[], CognitoError>> {
  const client = getClient();

  try {
    const command = new AdminListGroupsForUserCommand({
      UserPoolId: getUserPoolId(),
      Username: userId,
    });

    const response = await client.send(command);
    const groups = response.Groups ?? [];
    const teamIds = groups
      .map((g) => g.GroupName)
      .filter((name): name is string => name !== undefined) as TeamId[];

    return ok(teamIds);
  } catch (error: unknown) {
    if (isUserNotFoundError(error)) {
      return err({ kind: 'USER_NOT_FOUND', userId });
    }
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

/**
 * Checks if a user is a member of a specific team (Cognito group).
 */
export async function isUserInTeam(userId: string, teamId: TeamId): Promise<Result<boolean, CognitoError>> {
  const teamsResult = await getUserTeams(userId);
  if (!teamsResult.ok) {
    return teamsResult;
  }
  return ok(teamsResult.value.includes(teamId));
}

/**
 * Checks team membership from the token claims (fast path, no network call).
 * Use this when you already have a validated CognitoUser.
 */
export function isUserInTeamFromClaims(user: CognitoUser, teamId: TeamId): boolean {
  return user.teams.includes(teamId);
}

// =============================================================================
// API Gateway Lambda Authorizer
// =============================================================================

/** The shape of an API Gateway Lambda authorizer event. */
export interface AuthorizerEvent {
  headers?: Record<string, string | undefined>;
  requestContext?: {
    http?: {
      method: string;
      path: string;
    };
  };
}

/** The response from the authorizer middleware. */
export interface AuthorizerResult {
  isAuthorized: boolean;
  context?: {
    userId: string;
    email: string;
    teams: string;
  };
}

/**
 * Lambda authorizer function for API Gateway.
 * Validates the Bearer token from the Authorization header and extracts user identity.
 *
 * On success: returns isAuthorized=true with user context.
 * On failure: returns isAuthorized=false (API Gateway returns 401).
 */
export async function authorize(event: AuthorizerEvent): Promise<AuthorizerResult> {
  const authHeader = event.headers?.authorization ?? event.headers?.Authorization;

  const result = await extractUserIdentity(authHeader);

  if (!result.ok) {
    return { isAuthorized: false };
  }

  const user = result.value;

  return {
    isAuthorized: true,
    context: {
      userId: user.userId,
      email: user.email,
      teams: JSON.stringify(user.teams),
    },
  };
}

// =============================================================================
// Admin Operations (used by team-management.ts)
// =============================================================================

/**
 * Creates a new user in the Cognito User Pool via AdminCreateUser.
 * The user is created with a temporary password and an invitation email is sent.
 *
 * Cognito User Pool is configured with:
 * - selfSignUpEnabled: false
 * - allowAdminCreateUserOnly: true
 */
export async function adminCreateUser(params: {
  email: string;
  teamId: TeamId;
}): Promise<Result<{ userId: string; email: string }, CognitoError>> {
  const client = getClient();

  try {
    // Create the user with email as username
    const createCommand = new AdminCreateUserCommand({
      UserPoolId: getUserPoolId(),
      Username: params.email,
      UserAttributes: [
        { Name: 'email', Value: params.email },
        { Name: 'email_verified', Value: 'true' },
      ],
      DesiredDeliveryMediums: ['EMAIL'],
    });

    const createResponse = await client.send(createCommand);
    const userId = createResponse.User?.Username ?? params.email;

    // Add user to team group
    const addGroupCommand = new AdminAddUserToGroupCommand({
      UserPoolId: getUserPoolId(),
      Username: userId,
      GroupName: params.teamId,
    });

    await client.send(addGroupCommand);

    return ok({ userId, email: params.email });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

/**
 * Adds a user to a team group in Cognito.
 */
export async function adminAddUserToGroup(params: {
  userId: string;
  teamId: TeamId;
}): Promise<Result<void, CognitoError>> {
  const client = getClient();

  try {
    const command = new AdminAddUserToGroupCommand({
      UserPoolId: getUserPoolId(),
      Username: params.userId,
      GroupName: params.teamId,
    });

    await client.send(command);
    return ok(undefined);
  } catch (error: unknown) {
    if (isUserNotFoundError(error)) {
      return err({ kind: 'USER_NOT_FOUND', userId: params.userId });
    }
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

/**
 * Removes a user from a team group in Cognito.
 * This revokes their access on the next token refresh.
 */
export async function adminRemoveUserFromGroup(params: {
  userId: string;
  teamId: TeamId;
}): Promise<Result<void, CognitoError>> {
  const client = getClient();

  try {
    const command = new AdminRemoveUserFromGroupCommand({
      UserPoolId: getUserPoolId(),
      Username: params.userId,
      GroupName: params.teamId,
    });

    await client.send(command);
    return ok(undefined);
  } catch (error: unknown) {
    if (isUserNotFoundError(error)) {
      return err({ kind: 'USER_NOT_FOUND', userId: params.userId });
    }
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

/**
 * Gets a user's details from the Cognito User Pool.
 */
export async function adminGetUser(userId: string): Promise<Result<{ email: string; status: string }, CognitoError>> {
  const client = getClient();

  try {
    const command = new AdminGetUserCommand({
      UserPoolId: getUserPoolId(),
      Username: userId,
    });

    const response = await client.send(command);
    const emailAttr = response.UserAttributes?.find((attr) => attr.Name === 'email');
    const email = emailAttr?.Value ?? '';
    const status = response.UserStatus ?? 'UNKNOWN';

    return ok({ email, status });
  } catch (error: unknown) {
    if (isUserNotFoundError(error)) {
      return err({ kind: 'USER_NOT_FOUND', userId });
    }
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

/**
 * Creates a team group in the Cognito User Pool.
 */
export async function adminCreateGroup(teamId: TeamId): Promise<Result<void, CognitoError>> {
  const client = getClient();

  try {
    const command = new CreateGroupCommand({
      UserPoolId: getUserPoolId(),
      GroupName: teamId,
      Description: `Team group for ${teamId}`,
    });

    await client.send(command);
    return ok(undefined);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : 'Unknown Cognito error';
    return err({ kind: 'SERVICE_FAILURE', cause: message });
  }
}

// =============================================================================
// Helpers
// =============================================================================

function isUserNotFoundError(error: unknown): boolean {
  if (error && typeof error === 'object') {
    const name = (error as { name?: string }).name;
    return name === 'UserNotFoundException';
  }
  return false;
}

/**
 * Clears the JWKS cache (useful for testing).
 */
export function clearJWKSCache(): void {
  jwksCache = null;
}

/**
 * Resets the Cognito client instance (useful for testing).
 */
export function resetClient(): void {
  clientInstance = null;
}
