import { describe, it, expect } from 'vitest';
import { ok, err, isOk, isErr, map, flatMap, Result } from '@/types/result';

describe('Result<T, E> utilities', () => {
  describe('ok()', () => {
    it('creates a success result with a number', () => {
      const result = ok(42);
      expect(result).toEqual({ ok: true, value: 42 });
    });

    it('creates a success result with a string', () => {
      const result = ok('hello');
      expect(result).toEqual({ ok: true, value: 'hello' });
    });

    it('creates a success result with an object', () => {
      const obj = { name: 'test', count: 5 };
      const result = ok(obj);
      expect(result).toEqual({ ok: true, value: obj });
    });

    it('creates a success result with null', () => {
      const result = ok(null);
      expect(result).toEqual({ ok: true, value: null });
    });

    it('creates a success result with undefined', () => {
      const result = ok(undefined);
      expect(result).toEqual({ ok: true, value: undefined });
    });
  });

  describe('err()', () => {
    it('creates an error result with a string', () => {
      const result = err('something went wrong');
      expect(result).toEqual({ ok: false, error: 'something went wrong' });
    });

    it('creates an error result with a structured error', () => {
      const error = { kind: 'NOT_FOUND' as const, id: '123' };
      const result = err(error);
      expect(result).toEqual({ ok: false, error });
    });

    it('creates an error result with null', () => {
      const result = err(null);
      expect(result).toEqual({ ok: false, error: null });
    });
  });

  describe('isOk()', () => {
    it('returns true for a success result', () => {
      const result = ok(10);
      expect(isOk(result)).toBe(true);
    });

    it('returns false for an error result', () => {
      const result = err('fail');
      expect(isOk(result)).toBe(false);
    });

    it('narrows the type to access value', () => {
      const result: Result<number, string> = ok(99);
      if (isOk(result)) {
        expect(result.value).toBe(99);
      }
    });
  });

  describe('isErr()', () => {
    it('returns true for an error result', () => {
      const result = err('oops');
      expect(isErr(result)).toBe(true);
    });

    it('returns false for a success result', () => {
      const result = ok('good');
      expect(isErr(result)).toBe(false);
    });

    it('narrows the type to access error', () => {
      const result: Result<number, string> = err('bad');
      if (isErr(result)) {
        expect(result.error).toBe('bad');
      }
    });
  });

  describe('map()', () => {
    it('transforms the value in a success result', () => {
      const result = ok(5);
      const mapped = map(result, (v) => v * 2);
      expect(mapped).toEqual({ ok: true, value: 10 });
    });

    it('transforms string to number', () => {
      const result = ok('hello');
      const mapped = map(result, (s) => s.length);
      expect(mapped).toEqual({ ok: true, value: 5 });
    });

    it('passes through error without calling the function', () => {
      const result: Result<number, string> = err('error');
      let called = false;
      const mapped = map(result, (v) => {
        called = true;
        return v * 2;
      });
      expect(mapped).toEqual({ ok: false, error: 'error' });
      expect(called).toBe(false);
    });

    it('works with object transformations', () => {
      const result = ok({ x: 1, y: 2 });
      const mapped = map(result, (obj) => obj.x + obj.y);
      expect(mapped).toEqual({ ok: true, value: 3 });
    });
  });

  describe('flatMap()', () => {
    it('chains successful operations', () => {
      const result = ok(10);
      const chained = flatMap(result, (v) => ok(v.toString()));
      expect(chained).toEqual({ ok: true, value: '10' });
    });

    it('short-circuits on initial error', () => {
      const result: Result<number, string> = err('initial error');
      let called = false;
      const chained = flatMap(result, (v) => {
        called = true;
        return ok(v * 2);
      });
      expect(chained).toEqual({ ok: false, error: 'initial error' });
      expect(called).toBe(false);
    });

    it('propagates error from chained function', () => {
      const result = ok(0);
      const chained = flatMap(result, (v) =>
        v === 0 ? err('division by zero') : ok(100 / v)
      );
      expect(chained).toEqual({ ok: false, error: 'division by zero' });
    });

    it('chains multiple operations', () => {
      const parse = (s: string): Result<number, string> => {
        const n = parseInt(s, 10);
        return isNaN(n) ? err('not a number') : ok(n);
      };

      const double = (n: number): Result<number, string> =>
        ok(n * 2);

      const result = ok('21');
      const chained = flatMap(flatMap(result, parse), double);
      expect(chained).toEqual({ ok: true, value: 42 });
    });

    it('stops chain at first error in multi-step pipeline', () => {
      const parse = (s: string): Result<number, string> => {
        const n = parseInt(s, 10);
        return isNaN(n) ? err('not a number') : ok(n);
      };

      const double = (n: number): Result<number, string> =>
        ok(n * 2);

      const result = ok('abc');
      const chained = flatMap(flatMap(result, parse), double);
      expect(chained).toEqual({ ok: false, error: 'not a number' });
    });
  });
});
