'use client';

import { useState, FormEvent } from 'react';
import { TeamRole } from '@/types/domain';

export interface InviteUserFormProps {
  onSubmit: (email: string, role: TeamRole) => Promise<void>;
  existingEmails?: string[];
}

export function InviteUserForm({ onSubmit, existingEmails = [] }: InviteUserFormProps) {
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<TeamRole>('member');
  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  function validate(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return 'Email address is required.';
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(trimmed)) {
      return 'Please enter a valid email address.';
    }
    if (existingEmails.includes(trimmed)) {
      return 'This user has already been invited.';
    }
    return null;
  }

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    const validationError = validate(email);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setIsSubmitting(true);
    try {
      await onSubmit(email.trim(), role);
      setEmail('');
      setRole('member');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to invite user.');
    } finally {
      setIsSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex-1">
          <label htmlFor="invite-email" className="block text-sm font-medium text-gray-700">
            Email Address
          </label>
          <input
            id="invite-email"
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
              if (error) setError(null);
            }}
            placeholder="colleague@example.com"
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled={isSubmitting}
          />
        </div>
        <div className="w-full sm:w-36">
          <label htmlFor="invite-role" className="block text-sm font-medium text-gray-700">
            Role
          </label>
          <select
            id="invite-role"
            value={role}
            onChange={(e) => setRole(e.target.value as TeamRole)}
            className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            disabled={isSubmitting}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
        </div>
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isSubmitting ? 'Inviting...' : 'Invite User'}
        </button>
      </div>
      {error && (
        <p className="text-sm text-red-600" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
