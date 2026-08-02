import { useEffect, useState } from 'react';

/**
 * A value that only catches up to its source after it stops changing.
 *
 * Used for text filters wired straight into a query key: without this, every
 * keystroke re-keys the query, which both fires a request per character and
 * — since a fresh key starts with no data — flashes the results to "Loading…"
 * on every character typed. The input stays controlled and responsive as
 * typed; only the value handed to the query lags behind it.
 */
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
