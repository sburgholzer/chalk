/**
 * Result<T, E> - A discriminated union type for fallible operations.
 * Domain logic never throws; all operations that can fail return a typed Result.
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Create a successful Result containing the given value. */
export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

/** Create a failed Result containing the given error. */
export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

/** Type guard that narrows a Result to its success variant. */
export function isOk<T, E>(result: Result<T, E>): result is { ok: true; value: T } {
  return result.ok;
}

/** Type guard that narrows a Result to its error variant. */
export function isErr<T, E>(result: Result<T, E>): result is { ok: false; error: E } {
  return !result.ok;
}

/** Apply a transformation function to the value inside a successful Result. */
export function map<T, U, E>(result: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  if (isOk(result)) {
    return ok(fn(result.value));
  }
  return result;
}

/** Apply a function that returns a Result to the value inside a successful Result (monadic bind). */
export function flatMap<T, U, E>(result: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  if (isOk(result)) {
    return fn(result.value);
  }
  return result;
}
