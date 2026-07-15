'use client';

import { DecisionThread } from '@/types/domain';

export interface ThreadHeaderProps {
  thread: DecisionThread | undefined;
  roomId: string;
}

export function ThreadHeader({ thread, roomId }: ThreadHeaderProps) {
  return (
    <header className="border-b border-gray-200 bg-white px-4 py-3">
      <div className="flex items-center gap-3">
        <a
          href={`/rooms/${roomId}`}
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          ← Back to Room
        </a>
      </div>
      <h1 className="mt-2 text-lg font-bold text-gray-900">
        {thread?.title ?? 'Loading...'}
      </h1>

      {/* Reopen markers */}
      {thread?.reopenMarkers && thread.reopenMarkers.length > 0 && (
        <div className="mt-2 space-y-1">
          {thread.reopenMarkers.map((marker, i) => (
            <div
              key={i}
              className="rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-xs text-amber-800"
            >
              Reopened on {new Date(marker.timestamp).toLocaleDateString()}
              {marker.reason && ` — ${marker.reason}`}
            </div>
          ))}
        </div>
      )}

      {/* Supersession notice */}
      {thread?.supersededBy && (
        <div className="mt-2 rounded-md border border-yellow-200 bg-yellow-50 px-3 py-1.5 text-xs text-yellow-800">
          This thread has been superseded by a newer decision.
        </div>
      )}
    </header>
  );
}
