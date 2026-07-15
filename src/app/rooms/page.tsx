'use client';

import useSWR, { mutate } from 'swr';
import { Room } from '@/types/domain';
import { RoomList } from '@/components/RoomList';
import { RoomCreateForm } from '@/components/RoomCreateForm';
import { authFetcher, authRequest } from '@/lib/auth';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';

export function RoomsPage() {
  const { data: rooms, error, isLoading } = useSWR<Room[]>(
    `${API_URL}/rooms`,
    authFetcher
  );

  async function handleCreateRoom(name: string) {
    await authRequest(`${API_URL}/rooms`, {
      method: 'POST',
      body: JSON.stringify({ name }),
    });

    mutate(`${API_URL}/rooms`);
  }

  const existingNames = rooms?.map((r) => r.name) ?? [];

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Rooms</h1>
      <p className="mt-1 text-sm text-gray-600">
        Create and manage your architecture decision rooms.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">Create a Room</h2>
        <div className="mt-3">
          <RoomCreateForm
            onSubmit={handleCreateRoom}
            existingNames={existingNames}
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-gray-800">Your Rooms</h2>
        <div className="mt-3">
          <RoomList
            rooms={rooms ?? []}
            isLoading={isLoading}
            error={error?.message}
          />
        </div>
      </section>
    </main>
  );
}

export { RoomsPage as default };
