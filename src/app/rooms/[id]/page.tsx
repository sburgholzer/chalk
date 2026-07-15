'use client';

import { useParams } from 'next/navigation';
import useSWR from 'swr';
import { Room, DecisionThread } from '@/types/domain';
import { ThreadList } from '@/components/ThreadList';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

async function fetchRoom(url: string): Promise<Room> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch room');
  }
  return res.json();
}

async function fetchThreads(url: string): Promise<DecisionThread[]> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error('Failed to fetch threads');
  }
  return res.json();
}

export function RoomDetailPage() {
  const params = useParams<{ id: string }>();
  const roomId = params.id;

  const {
    data: room,
    error: roomError,
    isLoading: roomLoading,
  } = useSWR<Room>(`${API_URL}/rooms/${roomId}`, fetchRoom);

  const {
    data: threads,
    error: threadsError,
    isLoading: threadsLoading,
  } = useSWR<DecisionThread[]>(
    `${API_URL}/rooms/${roomId}/threads`,
    fetchThreads
  );

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
          Decision Threads
        </h2>
        <div className="mt-3">
          <ThreadList
            threads={threads ?? []}
            isLoading={threadsLoading}
            error={threadsError?.message}
          />
        </div>
      </section>
    </main>
  );
}

export { RoomDetailPage as default };
