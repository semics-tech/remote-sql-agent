/**
 * Diagnostics for job step bodies.
 *
 * These are not general-purpose language linters and are not trying to be. A
 * step body is a fragment executed by SQL Agent under a specific subsystem, and
 * the mistakes worth catching are the ones that behave *differently there* than
 * they do in SSMS or a console: a step that reports success while everything in
 * it failed, output that never reaches the job history, a batch separator inside
 * a block. Somebody who wants a full parser has SSMS.
 *
 * The bar for adding a rule is that a false positive would be rarer than the
 * bug. A linter people learn to ignore is worse than no linter, so anything
 * merely stylistic is left out.
 */

export type Severity = 'error' | 'warning' | 'info';

/** A finding, in Monaco's coordinates: 1-based line *and* column. */
export interface Diagnostic {
  /** Stable identifier, shown in the marker so a rule can be talked about. */
  code: string;
  severity: Severity;
  message: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
}

/**
 * Offset → line/column.
 *
 * Built once per lint pass rather than counting newlines per finding, because
 * the whole pass runs on every keystroke and a body with a few thousand lines
 * would otherwise be quadratic in the number of findings.
 */
export function makeLocator(text: string): (offset: number) => { line: number; column: number } {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) lineStarts.push(i + 1);
  }

  return (offset) => {
    const clamped = Math.max(0, Math.min(offset, text.length));
    // Rightmost line start at or before the offset.
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (lineStarts[mid]! <= clamped) low = mid;
      else high = mid - 1;
    }
    return { line: low + 1, column: clamped - lineStarts[low]! + 1 };
  };
}

export type Locator = ReturnType<typeof makeLocator>;

/** Build a diagnostic spanning `[start, end)` of the source. */
export function at(
  locate: Locator,
  start: number,
  end: number,
  fields: { code: string; severity: Severity; message: string },
): Diagnostic {
  const from = locate(start);
  // An empty span renders as a zero-width marker Monaco will not draw, so a
  // finding that reports the same offset twice still gets one character.
  const to = locate(Math.max(end, start + 1));
  return {
    ...fields,
    startLine: from.line,
    startColumn: from.column,
    endLine: to.line,
    endColumn: to.column,
  };
}

/**
 * Bodies past this size are not linted at all.
 *
 * The pass is linear, but it runs on every keystroke, and a generated script of
 * this size is not one anybody is hand-editing in this box — the cost lands on
 * typing latency and buys nothing. Silently doing less is the right trade here
 * *because* the editor keeps working; the alternative is a stuttering editor.
 */
export const MAX_LINTED_LENGTH = 200_000;

/**
 * Replace `[start, end)` with spaces, preserving newlines.
 *
 * Masking rather than tokenising is what lets the rules below be plain regexes
 * over the source while still ignoring anything inside a string or comment.
 * Length is preserved so every offset in the masked text is still an offset in
 * the original, and newlines survive so line numbers do too.
 */
export function blank(chars: string[], start: number, end: number): void {
  for (let i = start; i < end && i < chars.length; i += 1) {
    if (chars[i] !== '\n' && chars[i] !== '\r') chars[i] = ' ';
  }
}
