'use client';

import useSWR, { mutate } from 'swr';
import { TeamMember, TeamRole } from '@/types/domain';
import { TeamMemberList } from '@/components/TeamMemberList';
import { InviteUserForm } from '@/components/InviteUserForm';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? '';
const TEAM_ID = process.env.NEXT_PUBLIC_TEAM_ID ?? '';

interface MembersResponse {
  members: TeamMember[];
}

async function fetcher(url: string): Promise<TeamMember[]> {
  const res = await fetch(url);
  if (res.status === 403) {
    throw new ForbiddenError();
  }
  if (!res.ok) {
    throw new Error('Failed to fetch team members');
  }
  const data: MembersResponse = await res.json();
  return data.members;
}

class ForbiddenError extends Error {
  constructor() {
    super('Forbidden');
    this.name = 'ForbiddenError';
  }
}

export function TeamPage() {
  const membersKey = `${API_URL}/teams/${TEAM_ID}/members`;
  const { data: members, error, isLoading } = useSWR<TeamMember[]>(
    membersKey,
    fetcher
  );

  const isForbidden = error instanceof ForbiddenError;

  if (isForbidden) {
    return (
      <main className="mx-auto max-w-3xl px-4 py-8">
        <div className="rounded-md border border-red-200 bg-red-50 p-6 text-center">
          <h1 className="text-lg font-semibold text-red-800">Unauthorized</h1>
          <p className="mt-2 text-sm text-red-700">
            You do not have permission to access the Team Management page.
            Only team administrators can manage members.
          </p>
        </div>
      </main>
    );
  }

  async function handleInvite(email: string, role: TeamRole) {
    const res = await fetch(`${API_URL}/teams/${TEAM_ID}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to invite user');
    }

    mutate(membersKey);
  }

  async function handleRemove(userId: string) {
    const res = await fetch(`${API_URL}/teams/${TEAM_ID}/members/${userId}`, {
      method: 'DELETE',
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to remove user');
    }

    mutate(membersKey);
  }

  async function handleChangeRole(userId: string, newRole: TeamRole) {
    const res = await fetch(`${API_URL}/teams/${TEAM_ID}/members/${userId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ role: newRole }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? 'Failed to change role');
    }

    mutate(membersKey);
  }

  const activeEmails = members
    ?.filter((m) => m.status !== 'disabled')
    .map((m) => m.email) ?? [];

  return (
    <main className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-2xl font-bold text-gray-900">Team Management</h1>
      <p className="mt-1 text-sm text-gray-600">
        Manage your team members, invite new users, and assign roles.
      </p>

      <section className="mt-8">
        <h2 className="text-lg font-semibold text-gray-800">Invite User</h2>
        <div className="mt-3">
          <InviteUserForm
            onSubmit={handleInvite}
            existingEmails={activeEmails}
          />
        </div>
      </section>

      <section className="mt-10">
        <h2 className="text-lg font-semibold text-gray-800">Team Members</h2>
        <div className="mt-3">
          <TeamMemberList
            members={members ?? []}
            isLoading={isLoading}
            error={error && !isForbidden ? error.message : undefined}
            onRemove={handleRemove}
            onChangeRole={handleChangeRole}
          />
        </div>
      </section>
    </main>
  );
}

export { TeamPage as default };
