import { v4 as uuidv4 } from 'uuid';
import { Result, ok, err } from '@/types/result';
import { Room, RoomId, TeamId, RoomItem } from '@/types/domain';
import { putItemWithRetry, getItem, query } from '@/services/dynamo';

// =============================================================================
// Error Types
// =============================================================================

export type RoomError =
  | { kind: 'EMPTY_NAME' }
  | { kind: 'NAME_TOO_LONG'; maxLength: number }
  | { kind: 'DUPLICATE_NAME'; existingId: RoomId }
  | { kind: 'NOT_FOUND'; roomId: RoomId }
  | { kind: 'PERSISTENCE_FAILURE'; cause: string };

// =============================================================================
// Constants
// =============================================================================

const MAX_ROOM_NAME_LENGTH = 100;

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Validates a room name, rejecting empty, whitespace-only, and names exceeding 100 characters.
 * Returns the trimmed name on success.
 */
export function validateRoomName(name: string): Result<string, RoomError> {
  const trimmed = name.trim();

  if (trimmed.length === 0) {
    return err({ kind: 'EMPTY_NAME' });
  }

  if (trimmed.length > MAX_ROOM_NAME_LENGTH) {
    return err({ kind: 'NAME_TOO_LONG', maxLength: MAX_ROOM_NAME_LENGTH });
  }

  return ok(trimmed);
}

/**
 * Creates a new Room with a unique ID, validated name, and creation timestamp.
 * Checks for duplicate names within the team before persisting to DynamoDB.
 */
export async function createRoom(params: {
  name: string;
  teamId: TeamId;
  createdBy: string;
}): Promise<Result<Room, RoomError>> {
  // Validate the room name
  const nameResult = validateRoomName(params.name);
  if (!nameResult.ok) {
    return nameResult;
  }
  const validatedName = nameResult.value;

  // Check for duplicate names within the team
  const existingRoomsResult = await query<RoomItem>({
    pk: `TEAM#${params.teamId}`,
    skPrefix: 'ROOM#',
  });

  if (!existingRoomsResult.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: 'Failed to check for duplicate room names' });
  }

  const duplicate = existingRoomsResult.value.find(
    (room) => room.name === validatedName
  );

  if (duplicate) {
    return err({ kind: 'DUPLICATE_NAME', existingId: duplicate.roomId as RoomId });
  }

  // Generate unique ID and timestamp
  const roomId = uuidv4() as RoomId;
  const createdAt = new Date().toISOString();

  const room: Room = {
    roomId,
    teamId: params.teamId,
    name: validatedName,
    createdBy: params.createdBy,
    createdAt,
    threadCount: 0,
  };

  // Persist to DynamoDB
  const roomItem: RoomItem = {
    PK: `TEAM#${params.teamId}`,
    SK: `ROOM#${roomId}`,
    entityType: 'ROOM',
    roomId,
    teamId: params.teamId,
    name: validatedName,
    createdBy: params.createdBy,
    createdAt,
    threadCount: 0,
  };

  const writeResult = await putItemWithRetry(roomItem as RoomItem & Record<string, unknown>);

  if (!writeResult.ok) {
    let cause: string;
    switch (writeResult.error.kind) {
      case 'RETRIES_EXHAUSTED':
        cause = `Retries exhausted after ${writeResult.error.attempts} attempts: ${writeResult.error.lastError}`;
        break;
      case 'WRITE_FAILURE':
        cause = writeResult.error.cause;
        break;
      case 'CONDITION_CHECK_FAILED':
        cause = writeResult.error.message;
        break;
      default:
        cause = 'Unknown persistence error';
    }

    return err({ kind: 'PERSISTENCE_FAILURE', cause });
  }

  return ok(room);
}

/**
 * Retrieves a room by ID, enforcing team-scoped access.
 * Returns NOT_FOUND if the room doesn't exist or doesn't belong to the given team.
 */
export async function getRoom(
  roomId: RoomId,
  teamId: TeamId
): Promise<Result<Room, RoomError>> {
  const result = await getItem<RoomItem>({
    pk: `TEAM#${teamId}`,
    sk: `ROOM#${roomId}`,
  });

  if (!result.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: result.error.kind === 'READ_FAILURE' ? result.error.cause : 'Unknown read error' });
  }

  const item = result.value;

  if (!item) {
    return err({ kind: 'NOT_FOUND', roomId });
  }

  const room: Room = {
    roomId: item.roomId as RoomId,
    teamId: item.teamId as TeamId,
    name: item.name,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    threadCount: item.threadCount,
  };

  return ok(room);
}

/**
 * Lists all rooms for a given team by querying DynamoDB with the team partition key.
 */
export async function listRoomsForTeam(
  teamId: TeamId
): Promise<Result<Room[], RoomError>> {
  const result = await query<RoomItem>({
    pk: `TEAM#${teamId}`,
    skPrefix: 'ROOM#',
  });

  if (!result.ok) {
    return err({ kind: 'PERSISTENCE_FAILURE', cause: result.error.kind === 'READ_FAILURE' ? result.error.cause : 'Unknown read error' });
  }

  const rooms: Room[] = result.value.map((item) => ({
    roomId: item.roomId as RoomId,
    teamId: item.teamId as TeamId,
    name: item.name,
    createdBy: item.createdBy,
    createdAt: item.createdAt,
    threadCount: item.threadCount,
  }));

  return ok(rooms);
}
