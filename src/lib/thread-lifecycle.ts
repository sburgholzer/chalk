import { v4 as uuidv4 } from 'uuid';
import { Result, ok, err } from '@/types/result';
import {
  DecisionThread,
  ThreadId,
  RoomId,
  ThreadStatus,
  Option,
  ThreadItem,
} from '@/types/domain';
import { putItem } from '@/services/dynamo';

// =============================================================================
// Error Types
// =============================================================================

export type ThreadError =
  | { kind: 'INVALID_TRANSITION'; from: ThreadStatus; to: ThreadStatus; validTargets: ThreadStatus[] }
  | { kind: 'NOT_FOUND'; threadId: ThreadId }
  | { kind: 'PERSISTENCE_FAILURE'; cause: string };

// =============================================================================
// Valid Transitions Map
// =============================================================================

export const VALID_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  DRAFT: ['IN_PROGRESS'],
  IN_PROGRESS: ['DECIDED'],
  DECIDED: ['IN_PROGRESS', 'SUPERSEDED'],
  SUPERSEDED: [],
};

// =============================================================================
// Public Functions
// =============================================================================

/**
 * Check whether a transition from one status to another is valid.
 */
export function canTransition(from: ThreadStatus, to: ThreadStatus): boolean {
  return VALID_TRANSITIONS[from].includes(to);
}

/**
 * Create a new Decision Thread in DRAFT status and persist it to DynamoDB.
 */
export async function createThread(params: {
  roomId: RoomId;
  title: string;
  createdBy: string;
}): Promise<Result<DecisionThread, ThreadError>> {
  const threadId = uuidv4() as ThreadId;
  const now = new Date().toISOString();

  const thread: DecisionThread = {
    threadId,
    roomId: params.roomId,
    title: params.title,
    status: 'DRAFT',
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const item: ThreadItem = {
    PK: `ROOM#${params.roomId}`,
    SK: `THREAD#${threadId}`,
    GSI1PK: `ROOM#${params.roomId}`,
    GSI1SK: `STATUS#DRAFT#DATE#${now}`,
    entityType: 'THREAD',
    threadId,
    roomId: params.roomId,
    title: params.title,
    status: 'DRAFT',
    createdBy: params.createdBy,
    createdAt: now,
    updatedAt: now,
  };

  const writeResult = await putItem({ item: item as unknown as Record<string, unknown> });

  if (!writeResult.ok) {
    let cause: string;
    switch (writeResult.error.kind) {
      case 'WRITE_FAILURE':
        cause = writeResult.error.cause;
        break;
      case 'CONDITION_CHECK_FAILED':
        cause = writeResult.error.message;
        break;
      case 'RETRIES_EXHAUSTED':
        cause = `Retries exhausted after ${writeResult.error.attempts} attempts: ${writeResult.error.lastError}`;
        break;
      default:
        cause = writeResult.error.cause;
    }

    return err({ kind: 'PERSISTENCE_FAILURE', cause });
  }

  return ok(thread);
}

/**
 * Transition a thread to a new status. This is a pure/synchronous operation that
 * returns the updated thread state. Persistence is the caller's responsibility.
 *
 * Metadata is applied based on the transition:
 * - DRAFT → IN_PROGRESS: records transition timestamp in updatedAt
 * - IN_PROGRESS → DECIDED: records the selectedOption from metadata
 * - DECIDED → IN_PROGRESS: appends a reopen marker with timestamp and reason
 * - DECIDED → SUPERSEDED: sets supersededBy from metadata
 */
export function transition(
  thread: DecisionThread,
  targetStatus: ThreadStatus,
  metadata?: { selectedOption?: Option; supersededBy?: ThreadId; reopenReason?: string }
): Result<DecisionThread, ThreadError> {
  if (!canTransition(thread.status, targetStatus)) {
    return err({
      kind: 'INVALID_TRANSITION',
      from: thread.status,
      to: targetStatus,
      validTargets: VALID_TRANSITIONS[thread.status],
    });
  }

  const now = new Date().toISOString();

  const updatedThread: DecisionThread = {
    ...thread,
    status: targetStatus,
    updatedAt: now,
  };

  // Apply transition-specific metadata
  if (thread.status === 'IN_PROGRESS' && targetStatus === 'DECIDED' && metadata?.selectedOption) {
    updatedThread.selectedOption = metadata.selectedOption.summary;
  }

  if (thread.status === 'DECIDED' && targetStatus === 'IN_PROGRESS') {
    const marker = {
      timestamp: now,
      reason: metadata?.reopenReason ?? 'Reopened for reconsideration',
    };
    updatedThread.reopenMarkers = [...(thread.reopenMarkers ?? []), marker];
  }

  if (thread.status === 'DECIDED' && targetStatus === 'SUPERSEDED' && metadata?.supersededBy) {
    updatedThread.supersededBy = metadata.supersededBy;
  }

  return ok(updatedThread);
}
