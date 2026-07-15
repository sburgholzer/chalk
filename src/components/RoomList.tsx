'use client';

import { Room } from '@/types/domain';

export interface RoomListProps {
  rooms: Room[];
  isLoading: boolean;
  error?: string;
}

export function RoomList({ rooms, isLoading, error }: RoomListProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Loading rooms...</p>
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

  if (rooms.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-gray-500">No rooms yet. Create one to get started.</p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-gray-200 rounded-md border border-gray-200">
      {rooms.map((room) => (
        <li key={room.roomId}>
          <a
            href={`/rooms/${room.roomId}`}
            className="block px-4 py-3 hover:bg-gray-50 transition-colors"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-medium text-gray-900">
                  {room.name}
                </h3>
                <p className="mt-1 text-xs text-gray-500">
                  Created {new Date(room.createdAt).toLocaleDateString()}
                </p>
              </div>
              <span className="inline-flex items-center rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600">
                {room.threadCount} {room.threadCount === 1 ? 'thread' : 'threads'}
              </span>
            </div>
          </a>
        </li>
      ))}
    </ul>
  );
}
