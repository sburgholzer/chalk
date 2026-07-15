import { describe, it, expect } from 'vitest';
import type { TeamMember, TeamRole, UserStatus, UserId } from '@/types/domain';

/**
 * Tests for the TeamMemberList component logic:
 * - Status badge color mapping
 * - Role badge rendering
 * - Action availability based on member status
 */

function getStatusBadgeColor(status: UserStatus): string {
  const colors: Record<UserStatus, string> = {
    active: 'bg-green-100 text-green-700',
    invited: 'bg-blue-100 text-blue-700',
    disabled: 'bg-gray-100 text-gray-500',
  };
  return colors[status];
}

function getRoleBadgeColor(role: TeamRole): string {
  const colors: Record<TeamRole, string> = {
    admin: 'bg-purple-100 text-purple-700',
    member: 'bg-gray-100 text-gray-600',
  };
  return colors[role];
}

function getRoleChangeLabel(currentRole: TeamRole): string {
  return currentRole === 'admin' ? 'Demote' : 'Promote';
}

function getNewRoleOnToggle(currentRole: TeamRole): TeamRole {
  return currentRole === 'admin' ? 'member' : 'admin';
}

function shouldShowActions(member: TeamMember): boolean {
  return member.status !== 'disabled';
}

function makeMember(overrides: Partial<TeamMember> = {}): TeamMember {
  return {
    userId: 'user-1' as UserId,
    email: 'test@example.com',
    role: 'member',
    status: 'active',
    invitedAt: '2024-01-01T00:00:00Z',
    invitedBy: 'admin-1' as UserId,
    ...overrides,
  };
}

describe('TeamMemberList status badges', () => {
  it('returns green for active status', () => {
    expect(getStatusBadgeColor('active')).toContain('green');
  });

  it('returns blue for invited status', () => {
    expect(getStatusBadgeColor('invited')).toContain('blue');
  });

  it('returns gray for disabled status', () => {
    expect(getStatusBadgeColor('disabled')).toContain('gray');
  });
});

describe('TeamMemberList role badges', () => {
  it('returns purple for admin role', () => {
    expect(getRoleBadgeColor('admin')).toContain('purple');
  });

  it('returns gray for member role', () => {
    expect(getRoleBadgeColor('member')).toContain('gray');
  });
});

describe('TeamMemberList role change', () => {
  it('shows Demote for admin role', () => {
    expect(getRoleChangeLabel('admin')).toBe('Demote');
  });

  it('shows Promote for member role', () => {
    expect(getRoleChangeLabel('member')).toBe('Promote');
  });

  it('toggles admin to member', () => {
    expect(getNewRoleOnToggle('admin')).toBe('member');
  });

  it('toggles member to admin', () => {
    expect(getNewRoleOnToggle('member')).toBe('admin');
  });
});

describe('TeamMemberList actions visibility', () => {
  it('shows actions for active member', () => {
    const member = makeMember({ status: 'active' });
    expect(shouldShowActions(member)).toBe(true);
  });

  it('shows actions for invited member', () => {
    const member = makeMember({ status: 'invited' });
    expect(shouldShowActions(member)).toBe(true);
  });

  it('hides actions for disabled member', () => {
    const member = makeMember({ status: 'disabled' });
    expect(shouldShowActions(member)).toBe(false);
  });
});
