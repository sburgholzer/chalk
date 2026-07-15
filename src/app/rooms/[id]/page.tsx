'use client';

import { useState } from 'react';
import { useParams } from 'next/navigation';
import useSWR, { mutate } from 'swr';
import { Room, DecisionThread } from '@/types/domain';
import { ThreadList } from '@/components/ThreadList';
import { authFetcher, authRequest } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function RoomDetailPage() {
  const params = useParams<{ id: string }>();
  const roomId = params.id;
  const [threadTitle, setThreadTitle] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const {
    data,
    error: roomError,
    isLoading: roomLoading,
  } = useSWR<{ room: Room; threads: DecisionThread[] }>(
    `${API_URL}/rooms/${roomId}`,
    authFetcher
  );

  const room = data?.room;
  const threads = data?.threads ?? [];

  async function handleCreateThread(e: React.FormEvent) {
    e.preventDefault();
    if (!threadTitle.trim()) return;

    setIsCreating(true);
    setCreateError(null);
    try {
      await authRequest(`${API_URL}/rooms/${roomId}/threads`, {
        method: 'POST',
        body: JSON.stringify({ title: threadTitle.trim() }),
      });
      setThreadTitle('');
      mutate(`${API_URL}/rooms/${roomId}`);
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create thread');
    } finally {
      setIsCreating(false);
    }
  }

  if (roomLoading) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <p className="text-gray-500">Loading room...</p>
      </main>
    );
  }

  if (roomError) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-md border border-red-200 bg-red-50 p-4">
          <p className="text-sm text-red-700">{roomError.message}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="flex items-center gap-3">
        <a
          href="/rooms"
          className="text-sm text-blue-600 hover:text-blue-800"
        >
          ← Rooms
        </a>
      </div>

      <h1 className="mt-4 text-2xl font-bold text-gray-900">
        {room?.name ?? 'Room'}
      </h1>
      <p className="mt-1 text-sm text-gray-500">
        {room ? `Created ${new Date(room.createdAt).toLocaleDateString()}` : ''}
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">
          Start a Decision Thread
        </h2>
        <form onSubmit={handleCreateThread} className="mt-3 flex gap-2">
          <input
            type="text"
            value={threadTitle}
            onChange={(e) => setThreadTitle(e.target.value)}
            placeholder="e.g., Choose a database strategy"
            disabled={isCreating}
            className="flex-1 rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-gray-100"
          />
          <button
            type="submit"
            disabled={isCreating || !threadTitle.trim()}
            className="rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isCreating ? 'Creating...' : 'Start Thread'}
          </button>
        </form>
        {createError && (
          <p className="mt-2 text-sm text-red-600">{createError}</p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">
          Decision Threads
        </h2>
        <div className="mt-3">
          <ThreadList
            threads={threads}
            isLoading={roomLoading}
            error={roomError?.message}
          />
        </div>
      </section>
    </main>
  );
}

export { RoomDetailPage as default };
