'use client';

import { ThreadStatus } from '@/types/domain';

export interface ThreadStatusBarProps {
  status: ThreadStatus;
  onTransition: (target: ThreadStatus) => void;
  isTransitioning?: boolean;
}

const STATUS_LABELS: Record<ThreadStatus, string> = {
  DRAFT: 'Draft',
  IN_PROGRESS: 'In Progress',
  DECIDED: 'Decided',
  SUPERSEDED: 'Superseded',
};

const STATUS_COLORS: Record<ThreadStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700 border-gray-300',
  IN_PROGRESS: 'bg-blue-100 text-blue-700 border-blue-300',
  DECIDED: 'bg-green-100 text-green-700 border-green-300',
  SUPERSEDED: 'bg-yellow-100 text-yellow-700 border-yellow-300',
};

const VALID_TRANSITIONS: Record<ThreadStatus, ThreadStatus[]> = {
  DRAFT: ['IN_PROGRESS'],
  IN_PROGRESS: ['DECIDED'],
  DECIDED: ['IN_PROGRESS', 'SUPERSEDED'],
  SUPERSEDED: [],
};

const TRANSITION_LABELS: Record<string, string> = {
  IN_PROGRESS: 'Start Discussion',
  DECIDED: 'Mark as Decided',
  SUPERSEDED: 'Supersede',
};

export function ThreadStatusBar({
  status,
  onTransition,
  isTransitioning = false,
}: ThreadStatusBarProps) {
  const validTargets = VALID_TRANSITIONS[status];

  return (
    <div className="flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium text-gray-600">Status:</span>
        <span
          className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold ${STATUS_COLORS[status]}`}
        >
          {STATUS_LABELS[status]}
        </span>
      </div>

      {validTargets.length > 0 && (
        <div className="flex items-center gap-2">
          {validTargets.map((target) => (
            <button
              key={target}
              onClick={() => onTransition(target)}
              disabled={isTransitioning}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isTransitioning ? 'Updating...' : TRANSITION_LABELS[target] ?? target}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
