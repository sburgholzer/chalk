'use client';

import { useState } from 'react';
import { TeamMember, TeamRole, UserStatus } from '@/types/domain';
import { ConfirmDialog } from '@/components/ConfirmDialog';

export interface TeamMemberListProps {
  members: TeamMember[];
  isLoading: boolean;
  error?: string;
  onRemove: (userId: string) => Promise<void>;
  onChangeRole: (userId: string, newRole: TeamRole) => Promise<void>;
}

function StatusBadge({ status }: { status: UserStatus }) {
  const colors: Record<UserStatus, string> = {
    active: 'bg-green-100 text-green-700',
    invited: 'bg-blue-100 text-blue-700',
    disabled: 'bg-gray-100 text-gray-500',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[status]}`}
    >
      {status}
    </span>
  );
}

function RoleBadge({ role }: { role: TeamRole }) {
  const colors: Record<TeamRole, string> = {
    admin: 'bg-purple-100 text-purple-700',
    member: 'bg-gray-100 text-gray-600',
  };

  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${colors[role]}`}
    >
      {role}
    </span>
  );
}

export function TeamMemberList({
  members,
  isLoading,
  error,
  onRemove,
  onChangeRole,
}: TeamMemberListProps) {
  const [confirmAction, setConfirmAction] = useState<{
    type: 'remove' | 'role_change';
    userId: string;
    email: string;
    newRole?: TeamRole;
  } | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <p className="text-gray-500">Loading team members...</p>
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

  if (members.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12">
        <p className="text-gray-500">No team members found.</p>
      </div>
    );
  }

  function handleConfirm() {
    if (!confirmAction) return;
    if (confirmAction.type === 'remove') {
      onRemove(confirmAction.userId);
    } else if (confirmAction.type === 'role_change' && confirmAction.newRole) {
      onChangeRole(confirmAction.userId, confirmAction.newRole);
    }
    setConfirmAction(null);
  }

  const dialogTitle =
    confirmAction?.type === 'remove' ? 'Remove Team Member' : 'Change Role';

  const dialogMessage =
    confirmAction?.type === 'remove'
      ? `Are you sure you want to remove ${confirmAction.email} from the team? They will lose access to all rooms.`
      : `Are you sure you want to change ${confirmAction?.email}'s role to ${confirmAction?.newRole}?`;

  return (
    <>
      <div className="overflow-hidden rounded-md border border-gray-200">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                Email
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                Role
              </th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase text-gray-500">
                Status
              </th>
              <th className="px-4 py-3 text-right text-xs font-medium uppercase text-gray-500">
                Actions
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 bg-white">
            {members.map((member) => (
              <tr key={member.userId}>
                <td className="whitespace-nowrap px-4 py-3 text-sm text-gray-900">
                  {member.email}
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm">
                  <RoleBadge role={member.role} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-sm">
                  <StatusBadge status={member.status} />
                </td>
                <td className="whitespace-nowrap px-4 py-3 text-right text-sm">
                  {member.status !== 'disabled' && (
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            type: 'role_change',
                            userId: member.userId,
                            email: member.email,
                            newRole: member.role === 'admin' ? 'member' : 'admin',
                          })
                        }
                        className="text-xs font-medium text-blue-600 hover:text-blue-800"
                      >
                        {member.role === 'admin' ? 'Demote' : 'Promote'}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          setConfirmAction({
                            type: 'remove',
                            userId: member.userId,
                            email: member.email,
                          })
                        }
                        className="text-xs font-medium text-red-600 hover:text-red-800"
                      >
                        Remove
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <ConfirmDialog
        open={confirmAction !== null}
        title={dialogTitle}
        message={dialogMessage}
        confirmLabel={confirmAction?.type === 'remove' ? 'Remove' : 'Change Role'}
        variant={confirmAction?.type === 'remove' ? 'danger' : 'warning'}
        onConfirm={handleConfirm}
        onCancel={() => setConfirmAction(null)}
      />
    </>
  );
}
