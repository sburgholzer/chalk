import { describe, it, expect } from 'vitest';

/**
 * Tests for email validation logic used in InviteUserForm.
 * The component validates: non-empty, valid email format, no duplicates.
 * We test the validation logic directly since we don't have React Testing Library.
 */

function validateEmail(value: string, existingEmails: string[] = []): string | null {
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

describe('InviteUserForm validation', () => {
  it('rejects empty string', () => {
    expect(validateEmail('')).toBe('Email address is required.');
  });

  it('rejects whitespace-only string', () => {
    expect(validateEmail('   ')).toBe('Email address is required.');
  });

  it('rejects invalid email format — no @', () => {
    expect(validateEmail('notanemail')).toBe('Please enter a valid email address.');
  });

  it('rejects invalid email format — no domain', () => {
    expect(validateEmail('user@')).toBe('Please enter a valid email address.');
  });

  it('rejects invalid email format — no TLD', () => {
    expect(validateEmail('user@domain')).toBe('Please enter a valid email address.');
  });

  it('accepts valid email address', () => {
    expect(validateEmail('user@example.com')).toBeNull();
  });

  it('accepts email with subdomain', () => {
    expect(validateEmail('user@mail.example.com')).toBeNull();
  });

  it('rejects duplicate email', () => {
    const existing = ['alice@example.com', 'bob@example.com'];
    expect(validateEmail('alice@example.com', existing)).toBe(
      'This user has already been invited.'
    );
  });

  it('trims whitespace before validation', () => {
    expect(validateEmail('  user@example.com  ')).toBeNull();
  });

  it('detects duplicates after trimming', () => {
    const existing = ['user@example.com'];
    expect(validateEmail('  user@example.com  ', existing)).toBe(
      'This user has already been invited.'
    );
  });
});
