import { at, blank, makeLocator, type Diagnostic, type Locator } from './diagnostics.js';

/**
 * PowerShell step bodies.
 *
 * The rule this file exists for is `ps/step-cannot-fail`. A PowerShell job step
 * is reported as succeeded unless the script raises a *terminating* error or
 * exits non-zero, and almost nothing in PowerShell terminates by default — a
 * cmdlet that cannot reach a server writes to the error stream and execution
 * carries straight on to the next line. The result is a job that has been green
 * for two years and has not actually worked for one of them. Nothing in SSMS or
 * the Agent UI hints at it.
 *
 * As with the T-SQL rules, the scanner masks strings and comments first so no
 * rule can fire on text inside a literal. Here-strings matter more than usual
 * here: embedding a T-SQL script in `@' … '@` is the normal way to write these
 * steps, and a scanner that did not understand them would report the SQL inside
 * as unbalanced PowerShell.
 */

const MAX_PER_RULE = 5;

export function lintPowerShell(text: string): Diagnostic[] {
  const locate = makeLocator(text);
  const { masked, diagnostics } = scan(text, locate);

  const stops = stopsOnError(masked, text);
  return [
    ...diagnostics,
    ...bracketBalance(masked, locate),
    ...danglingContinuation(masked, locate),
    ...outcomeReporting(masked, locate, stops),
    ...advisories(masked, locate, stops),
  ];
}

/**
 * Whether the script sets `$ErrorActionPreference` to Stop.
 *
 * The assignment is found in the masked text — so a commented-out one does not
 * count — but the *value* is read from the original, because `'Stop'` is a
 * string literal and the mask has already blanked it. Checking the mask alone
 * meant the rule below could never see its own escape hatch, and every
 * correctly-written script was warned about.
 */
function stopsOnError(masked: string, text: string): boolean {
  // The match stops at the `=`. Consuming the whitespace after it in the regex
  // looks equivalent and is not: the mask has turned the literal into spaces,
  // so a greedy `\s*` swallows the very value being looked for. The gap is
  // skipped in the original text instead, where it is only ever real spaces.
  const pattern = /\$ErrorActionPreference\s*=/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    let from = match.index + match[0].length;
    while (from < text.length && (text[from] === ' ' || text[from] === '\t')) from += 1;
    if (/^['"]?Stop\b/i.test(text.slice(from, from + 8))) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface ScanResult {
  masked: string;
  diagnostics: Diagnostic[];
}

/** Characters after which a `#` starts a comment rather than being part of a word. */
const BEFORE_COMMENT = new Set([' ', '\t', '\n', '\r', ';', '{', '}', '(', ')', '|', ',', '=']);

function scan(text: string, locate: Locator): ScanResult {
  const chars = [...text];
  const diagnostics: Diagnostic[] = [];
  let i = 0;

  const unterminated = (start: number, what: string, code: string) => {
    diagnostics.push(
      at(locate, start, start + 2, {
        code,
        severity: 'error',
        message: `Unterminated ${what}. Everything after this is being read as part of it.`,
      }),
    );
  };

  while (i < text.length) {
    const c = text[i]!;
    const next = text[i + 1];

    // Backtick escapes the next character, including a quote, so it has to be
    // consumed before anything else looks at that character.
    if (c === '`') {
      i += 2;
      continue;
    }

    if (c === '<' && next === '#') {
      const start = i;
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '<' && text[i + 1] === '#') {
          depth += 1;
          i += 2;
        } else if (text[i] === '#' && text[i + 1] === '>') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      blank(chars, start, i);
      if (depth > 0) unterminated(start, 'block comment', 'ps/unterminated-comment');
      continue;
    }

    if (c === '#' && (i === 0 || BEFORE_COMMENT.has(text[i - 1]!))) {
      const end = indexOfOrEnd(text, '\n', i);
      blank(chars, i, end);
      i = end;
      continue;
    }

    // Here-string: `@'` or `@"` immediately followed by a line break. The
    // terminator must be at the very start of a line, which is why an embedded
    // `'@` inside the text does not end it.
    if (c === '@' && (next === "'" || next === '"') && /^\r?\n/.test(text.slice(i + 2, i + 4))) {
      const quote = next;
      const start = i;
      const terminator = `\n${quote}@`;
      const found = text.indexOf(terminator, i + 2);
      const end = found === -1 ? text.length : found + terminator.length;
      blank(chars, start, end);
      if (found === -1) unterminated(start, `here-string (${quote}@ never appears)`, 'ps/unterminated-string');
      i = end;
      continue;
    }

    if (c === "'" || c === '"') {
      const start = i;
      i += 1;
      let closed = false;
      while (i < text.length) {
        // A double-quoted string honours backtick escapes; a single-quoted one
        // does not, and its only escape is a doubled quote.
        if (c === '"' && text[i] === '`') {
          i += 2;
          continue;
        }
        if (text[i] === c) {
          if (text[i + 1] === c) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        // A line break inside a quoted string is legal in PowerShell, so there
        // is no cheap recovery point; an unterminated quote genuinely does
        // swallow the rest of the script, which is what makes it worth an error.
        i += 1;
      }
      blank(chars, start, i);
      if (!closed) unterminated(start, 'string', 'ps/unterminated-string');
      continue;
    }

    i += 1;
  }

  return { masked: chars.join(''), diagnostics };
}

function indexOfOrEnd(text: string, needle: string, from: number): number {
  const found = text.indexOf(needle, from);
  return found === -1 ? text.length : found;
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

const PAIRS: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
const CLOSERS: Record<string, string> = { '}': '{', ')': '(', ']': '[' };

function bracketBalance(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const open: Array<{ char: string; offset: number }> = [];

  for (let i = 0; i < masked.length; i += 1) {
    const c = masked[i]!;
    if (PAIRS[c]) {
      open.push({ char: c, offset: i });
      continue;
    }
    const wants = CLOSERS[c];
    if (!wants) continue;

    const top = open[open.length - 1];
    if (!top || top.char !== wants) {
      if (out.length < MAX_PER_RULE) {
        out.push(
          at(locate, i, i + 1, {
            code: 'ps/unbalanced-bracket',
            severity: 'error',
            message: top
              ? `Expected ${PAIRS[top.char]} to close the ${top.char} opened earlier, found ${c}.`
              : `Closing ${c} with nothing open.`,
          }),
        );
      }
      // Popping anyway keeps one stray closer from cascading into a report on
      // every bracket after it.
      if (top) open.pop();
      continue;
    }
    open.pop();
  }

  for (const item of open.slice(0, MAX_PER_RULE)) {
    out.push(
      at(locate, item.offset, item.offset + 1, {
        code: 'ps/unbalanced-bracket',
        severity: 'error',
        message: `This ${item.char} is never closed.`,
      }),
    );
  }
  return out;
}

/**
 * A backtick with trailing whitespace before the line break.
 *
 * The backtick escapes the space rather than the newline, so the line
 * continuation silently stops working and the next line becomes a separate
 * command. It is invisible in every editor that does not draw whitespace, and
 * it survives copy-paste through chat and ticketing systems, which is usually
 * how it arrives.
 */
function danglingContinuation(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const pattern = /`[ \t]+(?=\r?\n|$)/g;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null && out.length < MAX_PER_RULE) {
    out.push(
      at(locate, match.index, match.index + match[0].length, {
        code: 'ps/dangling-continuation',
        severity: 'error',
        message:
          'Trailing whitespace after the backtick. It escapes the space, not the line break, so this line does not continue onto the next one.',
      }),
    );
  }
  return out;
}

/** `(?!-)` so `Exit-PSSession` is not mistaken for an exit code. */
const HAS_EXIT = /(?:^|[\s;{}])exit\b(?!-)/i;
const HAS_THROW = /(?:^|[\s;{}])throw\b/i;
const HAS_TRAP = /(?:^|[\s;{}])trap\s*[{[]/i;
/** One cmdlet told to stop is enough to make the step able to fail. */
const STOPS_ONE_CMDLET = /-ErrorAction\s+Stop\b/i;

/**
 * Whether anything in the script can make the step fail.
 *
 * Reported once, at the top, rather than against a particular line: the finding
 * is about what the script does *not* contain, and there is no honest place to
 * put the squiggle.
 */
function outcomeReporting(masked: string, locate: Locator, stops: boolean): Diagnostic[] {
  if (masked.trim().length === 0) return [];
  if (
    stops ||
    STOPS_ONE_CMDLET.test(masked) ||
    HAS_EXIT.test(masked) ||
    HAS_THROW.test(masked) ||
    HAS_TRAP.test(masked)
  ) {
    return [];
  }

  const start = masked.search(/\S/);
  return [
    at(locate, start, start + 1, {
      code: 'ps/step-cannot-fail',
      severity: 'warning',
      message:
        'Nothing here can fail the step. SQL Agent marks a PowerShell step succeeded unless the script raises a terminating error or exits non-zero, and most errors in PowerShell are non-terminating — so a run where every command failed still reports green. Set $ErrorActionPreference = \'Stop\', or exit with a non-zero code.',
    }),
  ];
}

function advisories(masked: string, locate: Locator, globallyStops: boolean): Diagnostic[] {
  const out: Diagnostic[] = [];

  const push = (
    pattern: RegExp,
    fields: { code: string; severity: 'warning' | 'info'; message: string },
  ) => {
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = pattern.exec(masked)) !== null && count < MAX_PER_RULE) {
      count += 1;
      out.push(at(locate, match.index, match.index + match[0].length, fields));
    }
  };

  push(/\bWrite-Host\b/gi, {
    code: 'ps/write-host',
    severity: 'warning',
    message:
      "Write-Host writes to the host's display, not to the output stream SQL Agent captures, so none of this reaches the job history. Write-Output records it.",
  });

  push(/-ErrorAction\s+SilentlyContinue\b/gi, {
    code: 'ps/silently-continue',
    severity: 'info',
    message:
      'The error is discarded rather than recorded. Nothing downstream — including the job history — will show that this command failed.',
  });

  // Only worth saying when the script has not already set the preference
  // globally, which covers every cmdlet at once.
  if (!globallyStops) {
    const pattern = /\bInvoke-Sqlcmd\b/gi;
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = pattern.exec(masked)) !== null && count < MAX_PER_RULE) {
      const line = masked.slice(match.index, logicalLineEnd(masked, match.index));
      if (/-ErrorAction\s+Stop\b/i.test(line)) continue;
      count += 1;
      out.push(
        at(locate, match.index, match.index + match[0].length, {
          code: 'ps/sqlcmd-swallows-errors',
          severity: 'warning',
          message:
            'Without -ErrorAction Stop, a T-SQL error here is non-terminating: the script carries on to the next line and the step still succeeds.',
        }),
      );
    }
  }

  return out;
}

/** End of the command starting at `from`, following backtick continuations. */
function logicalLineEnd(masked: string, from: number): number {
  let i = from;
  while (i < masked.length) {
    if (masked[i] === '\n') {
      let back = i - 1;
      while (back >= 0 && (masked[back] === '\r' || masked[back] === ' ' || masked[back] === '\t')) {
        back -= 1;
      }
      // A trailing backtick continues the command; anything else ends it.
      if (masked[back] !== '`') return i;
    }
    i += 1;
  }
  return masked.length;
}
