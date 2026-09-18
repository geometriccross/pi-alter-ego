export type Result<T, E = string> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): { readonly ok: true; readonly value: T } {
  return { ok: true, value };
}

export function err<E>(error: E): { readonly ok: false; readonly error: E } {
  return { ok: false, error };
}

export function map<T, U, E = never>(result: Result<T, E>, transform: (value: T) => U): Result<U, E> {
  return result.ok ? ok(transform(result.value)) : result;
}

export function mapError<T, E, F>(result: Result<T, E>, transform: (error: E) => F): Result<T, F> {
  return result.ok ? result : err(transform(result.error));
}

export function traverse<T, U, E = never>(
  items: readonly T[],
  transform: (item: T) => Result<U, E>,
): Result<U[], E> {
  const values: U[] = [];
  for (const item of items) {
    const result = transform(item);
    if (!result.ok) return result;
    values.push(result.value);
  }
  return ok(values);
}

export function andThen<T, U, E = never, F = never>(
  result: Result<T, E>,
  next: (value: T) => Result<U, F>,
): Result<U, E | F> {
  return result.ok ? next(result.value) : result;
}

export async function andThenAsync<T, U, E = never, F = never>(
  result: Result<T, E>,
  next: (value: T) => Promise<Result<U, F>>,
): Promise<Result<U, E | F>> {
  return result.ok ? next(result.value) : result;
}

// Adapt throwing APIs at their boundary; ordinary composition does not catch errors.
export function attempt<T, E>(
  operation: () => T,
  onException: (error: unknown) => E,
): Result<T, E> {
  try {
    return ok(operation());
  } catch (error) {
    return err(onException(error));
  }
}

export async function recoverAsync<T, E>(
  operation: () => Promise<Result<T, E>>,
  onException: (error: unknown) => E,
): Promise<Result<T, E>> {
  try {
    return await operation();
  } catch (error) {
    return err(onException(error));
  }
}
