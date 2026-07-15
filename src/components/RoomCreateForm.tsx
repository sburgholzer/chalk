'use client';

import { useState, FormEvent } from 'react';

export interface RoomCreateFormProps {
  onSubmit: (name: string) => Promise<void>;
  existingNames?: string[];
}

export function RoomCreateForm({ onSubmit, existingNames = [] }: RoomCreateFormProps) {
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 'Room name cannot be empty.';
    }
    if (trimmed.length > 100) {
      return 'Room name cannot exceed 100 characters.';
    }
    if (existingNames.includes(trimmed)) {
      return 'A room with this name already exists.';
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validationError = validate(name);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(name.trim());
      setName('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create room.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div>
        <label htmlFor="room-name" className="block text-sm font-medium text-gray-700">
          Room Name
        </label>
        <input
          id="room-name"
          type="text"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (error) setError(null);
          }}
          placeholder="e.g., Payment Service Architecture"
          maxLength={101}
          className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          disabled={isSubmitting}
        />
        <p className="mt-1 text-xs text-gray-500">
          {name.trim().length}/100 characters
        </p>
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
      <button
        type="submit"
        disabled={isSubmitting}
        className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isSubmitting ? 'Creating...' : 'Create Room'}
      </button>
    </form>
  );
}
