'use client';

import { DecisionThread, ThreadStatus } from '@/types/domain';

export interface ThreadListProps {
  threads: DecisionThread[];
  isLoading: boolean;
  error?: string;
}

const STATUS_COLORS: Record<ThreadStatus, string> = {
  DRAFT: 'bg-gray-100 text-gray-700',
  IN_PROGRESS: 'bg-blue-100 text-blue-700',
  DECIDED: 'bg-green-100 text-green-700',
  SUPERSEDED: 'bg-yellow-100 text-yellow-700',
};

export function ThreadList({ threads, isLoading, error }: ThreadListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <p className="text-gray-500">Loading threads...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-red-200 bg-red-50 p-4">
        <p className="text-sm text-red-700">{error}</p>
      </div>
    );
  }

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-8">
        <p className="text-gray-500">No threads yet. Start a decision thread to begin.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
      {threads.map((thread) => (
        <li key={thread.threadId}>
          <a
            href={`/rooms/${thread.roomId}/threads/${thread.threadId}`}
            className="block px-4 py-3 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <h4 className="text-sm font-medium text-gray-900">
                  {thread.title}
                </h4>
                <p className="mt-1 text-xs text-gray-500">
                  Created {new Date(thread.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span
                className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ${STATUS_COLORS[thread.status]}`}
              >
                {thread.status.replace('_', ' ')}
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
