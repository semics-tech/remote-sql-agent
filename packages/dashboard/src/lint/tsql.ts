import { at, blank, makeLocator, type Diagnostic, type Locator } from './diagnostics.js';

/**
 * T-SQL step bodies.
 *
 * Two kinds of finding. Structural ones — an unterminated literal, a paste that
 * lost its closing bracket — are errors, because the batch will not compile and
 * SQL Agent will report a syntax error at 02:00 rather than now. The rest are
 * things that compile perfectly and then behave differently *inside a job step*
 * than they do when you press F5, which is the failure mode this product exists
 * to shorten.
 *
 * Nothing here parses T-SQL. The scanner below masks strings, comments and
 * quoted identifiers so the rules can be plain regexes that cannot fire on text
 * inside a literal — which is where a naive `\bGO\b` search goes wrong.
 */

/** Cap per rule, so a body that trips one rule everywhere stays readable. */
const MAX_PER_RULE = 5;

/**
 * Keywords after which a statement may legitimately begin without a preceding
 * semicolon: they open a block rather than end a statement. Without these,
 * `BEGIN CATCH` followed by `THROW;` — the textbook shape — is reported as a
 * missing semicolon.
 */
const BLOCK_OPENERS = new Set(['BEGIN', 'CATCH', 'TRY', 'ELSE', 'THEN', 'GO', 'AS', 'DO']);

/** `BEGIN TRANSACTION` is not a block: it has no matching `END`. */
const NON_BLOCK_AFTER_BEGIN = new Set(['TRAN', 'TRANSACTION', 'DISTRIBUTED', 'DIALOG']);

export function lintTsql(text: string): Diagnostic[] {
  const locate = makeLocator(text);
  const { masked, diagnostics } = scan(text, locate);

  return [
    ...diagnostics,
    ...parenBalance(masked, locate),
    ...blockStructure(masked, locate),
    ...raiserrorSeverity(masked, locate),
    ...statementSeparators(masked, locate),
    ...unqualifiedWrites(masked, locate),
    ...advisories(masked, locate),
  ];
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface ScanResult {
  masked: string;
  diagnostics: Diagnostic[];
}

/**
 * Blank out everything the rules must not see inside.
 *
 * Block comments nest in T-SQL: an inner open-comment has to be closed before
 * the outer one ends, so a body containing two nested comments is one comment
 * and not one comment plus stray code. Depth is counted for that reason, rather
 * than stopping at the first close-comment marker.
 */
function scan(text: string, locate: Locator): ScanResult {
  const chars = [...text];
  const diagnostics: Diagnostic[] = [];
  let i = 0;

  const unterminated = (start: number, what: string, code: string) => {
    diagnostics.push(
      at(locate, start, start + 2, {
        code,
        severity: 'error',
        message: `Unterminated ${what}. Everything after this is being read as part of it, so the batch will not compile.`,
      }),
    );
  };

  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];

    if (c === '-' && next === '-') {
      const end = indexOfOrEnd(text, '\n', i);
      blank(chars, i, end);
      i = end;
      continue;
    }

    if (c === '/' && next === '*') {
      const start = i;
      let depth = 0;
      while (i < text.length) {
        if (text[i] === '/' && text[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (text[i] === '*' && text[i + 1] === '/') {
          depth -= 1;
          i += 2;
          if (depth === 0) break;
        } else {
          i += 1;
        }
      }
      blank(chars, start, i);
      if (depth > 0) unterminated(start, 'block comment', 'tsql/unterminated-comment');
      continue;
    }

    if (c === "'" || c === '"' || c === '[') {
      const close = c === '[' ? ']' : c;
      const start = i;
      i += 1;
      let closed = false;
      while (i < text.length) {
        if (text[i] === close) {
          // A doubled delimiter is an escaped one, not the end.
          if (text[i + 1] === close) {
            i += 2;
            continue;
          }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      blank(chars, start, i);
      if (!closed) {
        unterminated(
          start,
          c === "'" ? 'string literal' : 'quoted identifier',
          c === "'" ? 'tsql/unterminated-string' : 'tsql/unterminated-identifier',
        );
      }
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

function parenBalance(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const open: number[] = [];

  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === '(') open.push(i);
    else if (masked[i] === ')') {
      if (open.length === 0 && out.length < MAX_PER_RULE) {
        out.push(
          at(locate, i, i + 1, {
            code: 'tsql/unbalanced-paren',
            severity: 'error',
            message: 'Closing bracket with nothing open.',
          }),
        );
      }
      open.pop();
    }
  }

  for (const start of open.slice(0, MAX_PER_RULE)) {
    out.push(
      at(locate, start, start + 1, {
        code: 'tsql/unbalanced-paren',
        severity: 'error',
        message: 'This bracket is never closed.',
      }),
    );
  }
  return out;
}

/**
 * `BEGIN`/`CASE` against `END`, and any `GO` that lands inside one.
 *
 * A batch separator inside a block is the interesting half. `GO` is not a
 * statement — it tells the client to send everything above it as one batch — so
 * a `GO` between `BEGIN` and `END` splits the block in two and each half fails
 * to compile on its own. It is easy to introduce by pasting two working scripts
 * together and impossible to see by reading.
 */
function blockStructure(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  const open: Array<{ offset: number; keyword: string }> = [];
  // `GO` is only a separator when it is alone on its line, which is also what
  // stops `SELECT go FROM …` being read as one.
  const pattern = /\b(BEGIN|END|CASE)\b|^[ \t]*(GO)(?:[ \t]+\d+)?[ \t]*$/gim;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null) {
    const keyword = match[1]?.toUpperCase();
    // The GO alternative carries the rest of its line, so the keyword's own
    // offset has to be found inside the match rather than assumed to be at its
    // start — otherwise the marker lands on the whitespace after it.
    const offset = match.index + match[0].search(/\S/);

    if (match[2]) {
      if (open.length > 0 && out.length < MAX_PER_RULE) {
        out.push(
          at(locate, offset, offset + 2, {
            code: 'tsql/go-inside-block',
            severity: 'error',
            message:
              'GO ends the batch here, splitting the block above it in half. Each half is compiled separately and neither is valid on its own.',
          }),
        );
      }
      continue;
    }

    if (keyword === 'CASE') {
      open.push({ offset, keyword });
    } else if (keyword === 'BEGIN') {
      if (!NON_BLOCK_AFTER_BEGIN.has(wordAfter(masked, match.index + match[0].length))) {
        open.push({ offset, keyword });
      }
    } else if (keyword === 'END') {
      // `END CONVERSATION` closes a Service Broker dialogue, not a block.
      if (wordAfter(masked, match.index + match[0].length) === 'CONVERSATION') continue;
      if (open.length === 0) {
        if (out.length < MAX_PER_RULE) {
          out.push(
            at(locate, offset, offset + 3, {
              code: 'tsql/unbalanced-block',
              severity: 'error',
              message: 'This END closes nothing — there is no BEGIN or CASE open here.',
            }),
          );
        }
      } else {
        open.pop();
      }
    }
  }

  for (const item of open.slice(0, MAX_PER_RULE)) {
    out.push(
      at(locate, item.offset, item.offset + item.keyword.length, {
        code: 'tsql/unbalanced-block',
        severity: 'error',
        message: `This ${item.keyword} has no matching END.`,
      }),
    );
  }
  return out;
}

/** The next bare word after `offset`, upper-cased; '' if there is none. */
function wordAfter(masked: string, offset: number): string {
  const match = /^[\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(masked.slice(offset, offset + 64));
  return match ? match[1]!.toUpperCase() : '';
}

/**
 * `RAISERROR` below severity 11 does not fail a job step.
 *
 * Severities 0–10 are informational: they raise no error condition, so the
 * batch carries on, SQL Agent sees a clean exit and marks the step succeeded.
 * A script that "reports failure" this way has been silently succeeding for as
 * long as it has existed, which is exactly the case nobody notices.
 */
function raiserrorSeverity(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];
  // The message argument holds no comma once strings are masked, so a lazy
  // "up to the first comma" read of it is safe here.
  const pattern = /\bRAISERROR\s*\(\s*[^,()]*,\s*(\d+)\s*,/gi;

  let match: RegExpExecArray | null;
  while ((match = pattern.exec(masked)) !== null && out.length < MAX_PER_RULE) {
    const severity = Number(match[1]);
    if (severity > 10) continue;
    out.push(
      at(locate, match.index, match.index + match[0].length, {
        code: 'tsql/raiserror-not-fatal',
        severity: 'warning',
        message: `Severity ${severity} is informational, so this does not fail the step — SQL Agent will record the job as succeeded. Use 11 or above to fail it.`,
      }),
    );
  }
  return out;
}

/**
 * Statements that must be preceded by a semicolon.
 *
 * `WITH` is only checked when it opens a common table expression: `CREATE INDEX
 * … WITH (ONLINE = ON)` and `FROM t WITH (NOLOCK)` are the same keyword and are
 * fine unterminated, and flagging those would make the rule worthless.
 */
function statementSeparators(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];

  const checks: Array<{ pattern: RegExp; name: string }> = [
    // A CTE is `WITH <name> [(cols)] AS (`. Requiring the `AS (` is what tells
    // it apart from the hint and option forms of the same word.
    {
      pattern: /\bWITH\s+(?:[A-Za-z_][\w$@#]*|\s)+(?:\([^()]{0,400}\)\s*)?AS\s*\(/gi,
      name: 'a common table expression',
    },
    { pattern: /\bTHROW\b/gi, name: 'THROW' },
    { pattern: /\bMERGE\s+(?:INTO\s+)?[\w$@#.]/gi, name: 'MERGE' },
  ];

  for (const { pattern, name } of checks) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(masked)) !== null && out.length < MAX_PER_RULE) {
      if (precededByBoundary(masked, match.index)) continue;
      out.push(
        at(locate, match.index, match.index + Math.min(match[0].length, 24), {
          code: 'tsql/missing-semicolon',
          severity: 'warning',
          message: `T-SQL requires the statement before ${name} to end with a semicolon.`,
        }),
      );
    }
  }
  return out;
}

/** True when nothing needs terminating before `offset`. */
function precededByBoundary(masked: string, offset: number): boolean {
  let i = offset - 1;
  while (i >= 0 && /\s/.test(masked[i]!)) i -= 1;
  if (i < 0) return true;
  if (masked[i] === ';') return true;

  const end = i + 1;
  while (i >= 0 && /[A-Za-z0-9_]/.test(masked[i]!)) i -= 1;
  return BLOCK_OPENERS.has(masked.slice(i + 1, end).toUpperCase());
}

/**
 * `DELETE` and `UPDATE` with no `WHERE` anywhere in the statement.
 *
 * Deliberately a warning, not an error: purging a staging table wholesale is a
 * perfectly ordinary thing for a scheduled job to do. It is flagged anyway
 * because the same shape reaching a permanent table is the single most
 * expensive mistake in this file, and a job step runs unattended with no
 * "you are about to affect 4,000,000 rows" to stop it.
 */
function unqualifiedWrites(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];

  for (const stmt of statements(masked)) {
    if (out.length >= MAX_PER_RULE) break;
    const body = masked.slice(stmt.start, stmt.end);
    const head =
      /^\s*(DELETE|UPDATE)\s+(?:TOP\s*\([^()]*\)\s*)?(?:FROM\s+)?([^\s,;()]+)/i.exec(body);
    if (!head) continue;

    const verb = head[1]!.toUpperCase();
    const target = head[2] ?? '';
    // `UPDATE STATISTICS` is maintenance, not a row write.
    if (verb === 'UPDATE' && target.toUpperCase() === 'STATISTICS') continue;
    // Temp tables and table variables are per-run scratch; emptying one whole
    // is the normal way to use it.
    if (target.startsWith('#') || target.startsWith('@')) continue;
    if (/\bWHERE\b/i.test(body)) continue;

    const offset = stmt.start + head.index + head[0].search(/\S/);
    out.push(
      at(locate, offset, offset + verb.length, {
        code: 'tsql/write-without-where',
        severity: 'warning',
        message: `This ${verb} has no WHERE clause, so it affects every row in ${target}.`,
      }),
    );
  }
  return out;
}

/**
 * Statement spans, split on semicolons and on `GO` lines.
 *
 * A separator is a *range*, not a position: a `GO` line is two characters plus
 * whatever indentation and batch count it carries, and resuming one character
 * past its start leaves the rest of the word at the front of the next statement
 * — which then no longer begins with the keyword any rule is looking for.
 */
function statements(masked: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  const separators: Array<{ start: number; end: number }> = [];

  for (let i = 0; i < masked.length; i += 1) {
    if (masked[i] === ';') separators.push({ start: i, end: i + 1 });
  }
  const go = /^[ \t]*GO(?:[ \t]+\d+)?[ \t]*$/gim;
  let match: RegExpExecArray | null;
  while ((match = go.exec(masked)) !== null) {
    separators.push({ start: match.index, end: match.index + match[0].length });
  }
  separators.sort((a, b) => a.start - b.start);

  let start = 0;
  for (const separator of separators) {
    if (separator.start > start) out.push({ start, end: separator.start });
    start = separator.end;
  }
  if (start < masked.length) out.push({ start, end: masked.length });
  return out;
}

/** Things worth knowing about, none of which are wrong on their own. */
function advisories(masked: string, locate: Locator): Diagnostic[] {
  const out: Diagnostic[] = [];

  const rules: Array<{ pattern: RegExp; code: string; severity: 'warning' | 'info'; message: string }> =
    [
      {
        pattern: /\bxp_cmdshell\b/gi,
        code: 'tsql/xp-cmdshell',
        severity: 'warning',
        message:
          'xp_cmdshell is disabled by default and needs sysadmin to enable. The step fails with a permissions error, not a script error, on any server where nobody has turned it on.',
      },
      {
        pattern: /\b(?:NOLOCK|READUNCOMMITTED)\b/gi,
        code: 'tsql/nolock',
        severity: 'info',
        message:
          'NOLOCK reads uncommitted data and can return a row twice or skip one entirely during a page split — not just slightly stale data.',
      },
    ];

  for (const rule of rules) {
    let match: RegExpExecArray | null;
    let count = 0;
    while ((match = rule.pattern.exec(masked)) !== null && count < MAX_PER_RULE) {
      count += 1;
      out.push(
        at(locate, match.index, match.index + match[0].length, {
          code: rule.code,
          severity: rule.severity,
          message: rule.message,
        }),
      );
    }
  }
  return out;
}
