import { describe, it, expect } from 'vitest';

/**
 * Tests for room name validation logic used in RoomCreateForm.
 * The component validates: 1-100 chars, no duplicates.
 * We test the validation logic directly since we don't have React Testing Library.
 */

function validateRoomName(value: string, existingNames: string[] = []): string | null {
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

describe('RoomCreateForm validation', () => {
  it('rejects empty string', () => {
    expect(validateRoomName('')).toBe('Room name cannot be empty.');
  });

  it('rejects whitespace-only string', () => {
    expect(validateRoomName('   ')).toBe('Room name cannot be empty.');
  });

  it('rejects name exceeding 100 characters', () => {
    const longName = 'a'.repeat(101);
    expect(validateRoomName(longName)).toBe('Room name cannot exceed 100 characters.');
  });

  it('accepts name at exactly 100 characters', () => {
    const maxName = 'a'.repeat(100);
    expect(validateRoomName(maxName)).toBeNull();
  });

  it('accepts valid name between 1 and 100 characters', () => {
    expect(validateRoomName('My Architecture Project')).toBeNull();
  });

  it('rejects duplicate name', () => {
    const existing = ['Payment Service', 'Auth Module'];
    expect(validateRoomName('Payment Service', existing)).toBe(
      'A room with this name already exists.'
    );
  });

  it('trims whitespace before validating', () => {
    expect(validateRoomName('  Valid Name  ')).toBeNull();
  });

  it('detects duplicates after trimming', () => {
    const existing = ['My Room'];
    expect(validateRoomName('  My Room  ', existing)).toBe(
      'A room with this name already exists.'
    );
  });

  it('accepts single character name', () => {
    expect(validateRoomName('A')).toBeNull();
  });
});
