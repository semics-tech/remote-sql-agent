import { describe, expect, it } from 'vitest';
import { lintPowerShell, lintStepBody, lintTsql, summariseDiagnostics } from '../src/lint/index.js';

/**
 * The rules are only worth having if they are quiet.
 *
 * Every rule below is pinned twice: once on the shape it is meant to catch, and
 * once on the legitimate code that looks like it. The second half is the half
 * that matters — a linter that cries wolf on `CREATE INDEX … WITH (ONLINE = ON)`
 * gets switched off in a week, and then the real findings go with it.
 */

const codes = (diagnostics: Array<{ code: string }>) => diagnostics.map((d) => d.code);

describe('T-SQL: structural errors', () => {
  it('reports an unterminated string at the quote that opened it', () => {
    const found = lintTsql("SELECT 'oops\nFROM dbo.Thing;");
    expect(codes(found)).toContain('tsql/unterminated-string');
    expect(found[0]).toMatchObject({ severity: 'error', startLine: 1, startColumn: 8 });
  });

  it('does not mistake a doubled quote for the end of a string', () => {
    expect(lintTsql("SELECT 'it''s fine';")).toEqual([]);
  });

  it('treats nested block comments as one comment', () => {
    // SQL Server nests these. Stopping at the first */ would leave the trailing
    // */ as stray code and report a phantom error.
    expect(lintTsql('/* outer /* inner */ still outer */ SELECT 1;')).toEqual([]);
  });

  it('reports a block comment that is never closed', () => {
    expect(codes(lintTsql('/* SELECT 1;'))).toEqual(['tsql/unterminated-comment']);
  });

  it('ignores brackets and keywords inside strings and comments', () => {
    const body = "-- BEGIN (\nSELECT 'END )' AS x; /* ( BEGIN */";
    expect(lintTsql(body)).toEqual([]);
  });

  it('reports a bracket that is never closed', () => {
    expect(codes(lintTsql('SELECT COUNT(* FROM dbo.Thing;'))).toContain('tsql/unbalanced-paren');
  });
});

describe('T-SQL: block structure', () => {
  it('accepts BEGIN TRY / BEGIN CATCH', () => {
    const body = [
      'BEGIN TRY',
      '    SELECT 1;',
      'END TRY',
      'BEGIN CATCH',
      '    THROW;',
      'END CATCH',
    ].join('\n');
    expect(lintTsql(body)).toEqual([]);
  });

  it('does not expect an END for BEGIN TRANSACTION', () => {
    // The trap a naive BEGIN/END count falls into: this is balanced and has no
    // END at all.
    expect(lintTsql('BEGIN TRANSACTION;\nUPDATE dbo.T SET a = 1 WHERE id = 1;\nCOMMIT;')).toEqual(
      [],
    );
  });

  it('counts CASE as needing an END', () => {
    expect(lintTsql('SELECT CASE WHEN 1 = 1 THEN 1 ELSE 0 END AS x;')).toEqual([]);
    expect(codes(lintTsql('SELECT CASE WHEN 1 = 1 THEN 1 ELSE 0 AS x;'))).toContain(
      'tsql/unbalanced-block',
    );
  });

  it('reports an END that closes nothing', () => {
    expect(codes(lintTsql('SELECT 1;\nEND'))).toEqual(['tsql/unbalanced-block']);
  });

  it('reports GO inside a block', () => {
    const body = ['IF @x = 1', 'BEGIN', '    SELECT 1;', 'GO', '    SELECT 2;', 'END'].join('\n');
    const found = lintTsql(body);
    expect(codes(found)).toContain('tsql/go-inside-block');
    expect(found.find((d) => d.code === 'tsql/go-inside-block')).toMatchObject({ startLine: 4 });
  });

  it('accepts GO between complete batches', () => {
    expect(lintTsql('SELECT 1;\nGO\nSELECT 2;\nGO 3\n')).toEqual([]);
  });

  it('does not treat the word "go" in an expression as a batch separator', () => {
    expect(lintTsql("BEGIN\n    SELECT go FROM dbo.T;\nEND")).toEqual([]);
  });
});

describe('T-SQL: things that compile and then behave differently in a job step', () => {
  it('flags RAISERROR below severity 11', () => {
    const found = lintTsql("RAISERROR('Import failed', 10, 1);");
    expect(codes(found)).toEqual(['tsql/raiserror-not-fatal']);
    expect(found[0]!.message).toContain('succeeded');
  });

  it('accepts RAISERROR at severity 16', () => {
    expect(lintTsql("RAISERROR(N'Import failed', 16, 1);")).toEqual([]);
  });

  it('flags DELETE with no WHERE', () => {
    expect(codes(lintTsql('DELETE FROM dbo.Orders;'))).toEqual(['tsql/write-without-where']);
  });

  it('leaves scratch tables alone', () => {
    // Emptying a temp table or a table variable wholesale is how they are used.
    expect(lintTsql('DELETE FROM #staging;\nDELETE @batch;')).toEqual([]);
  });

  it('does not mistake UPDATE STATISTICS for a row write', () => {
    expect(lintTsql('UPDATE STATISTICS dbo.Orders;')).toEqual([]);
  });

  it('still sees the first statement of a batch after GO', () => {
    // Regression: the GO separator was consuming one character rather than the
    // whole line, so the next statement began "O\n  DELETE …" and no rule
    // anchored to the leading keyword could match it.
    const found = lintTsql('SELECT 1;\nGO\nDELETE FROM dbo.Orders;');
    expect(codes(found)).toEqual(['tsql/write-without-where']);
  });

  it('warns about xp_cmdshell and notes NOLOCK', () => {
    const found = lintTsql('SELECT * FROM dbo.T WITH (NOLOCK);\nEXEC master..xp_cmdshell @cmd;');
    expect(codes(found).sort()).toEqual(['tsql/nolock', 'tsql/xp-cmdshell']);
    expect(found.find((d) => d.code === 'tsql/nolock')!.severity).toBe('info');
  });
});

describe('T-SQL: semicolons before statements that require one', () => {
  it('flags a CTE that follows an unterminated statement', () => {
    const body = 'SELECT 1\nWITH src AS (SELECT 1 AS a)\nSELECT * FROM src;';
    expect(codes(lintTsql(body))).toContain('tsql/missing-semicolon');
  });

  it('accepts a CTE that follows a semicolon', () => {
    expect(lintTsql('SELECT 1;\nWITH src AS (SELECT 1 AS a)\nSELECT * FROM src;')).toEqual([]);
  });

  it('does not flag WITH as a table hint or an index option', () => {
    // Both of these begin a line in ordinary formatting and neither needs a
    // preceding semicolon. This is the false positive that would sink the rule.
    const hint = 'SELECT *\nFROM dbo.Orders o\nWITH (NOLOCK)\nWHERE o.Id = 1;';
    expect(codes(lintTsql(hint))).not.toContain('tsql/missing-semicolon');

    const option = 'CREATE INDEX ix_a ON dbo.Orders (a)\nWITH (ONLINE = ON);';
    expect(codes(lintTsql(option))).not.toContain('tsql/missing-semicolon');
  });

  it('accepts THROW straight after BEGIN CATCH but not after a statement', () => {
    const fine = 'BEGIN CATCH\n    THROW;\nEND CATCH';
    expect(codes(lintTsql(fine))).not.toContain('tsql/missing-semicolon');

    const broken = 'BEGIN CATCH\n    ROLLBACK TRANSACTION\n    THROW;\nEND CATCH';
    expect(codes(lintTsql(broken))).toContain('tsql/missing-semicolon');
  });
});

describe('PowerShell: the step that cannot fail', () => {
  it('warns when nothing in the script can fail the step', () => {
    const found = lintPowerShell('Get-Content C:\\reports\\daily.txt | Set-Content \\\\nas\\daily.txt');
    expect(codes(found)).toContain('ps/step-cannot-fail');
    expect(found.find((d) => d.code === 'ps/step-cannot-fail')!.severity).toBe('warning');
  });

  it.each([
    ["$ErrorActionPreference = 'Stop'\nGet-Content x.txt", 'the preference set globally'],
    ['Get-Content x.txt -ErrorAction Stop', 'one cmdlet told to stop'],
    ['if (-not (Test-Path x)) { throw "missing" }', 'a throw'],
    ['try { Get-Content x } catch { exit 1 }', 'an explicit exit code'],
  ])('stays quiet given %s', (body) => {
    expect(codes(lintPowerShell(body))).not.toContain('ps/step-cannot-fail');
  });

  it('says nothing at all about an empty body', () => {
    expect(lintPowerShell('   \n\n')).toEqual([]);
  });

  it('does not mistake Exit-PSSession for an exit code', () => {
    expect(codes(lintPowerShell('Exit-PSSession'))).toContain('ps/step-cannot-fail');
  });
});

describe('PowerShell: structure', () => {
  it('understands here-strings, so embedded T-SQL is not read as PowerShell', () => {
    // The normal way to write one of these steps. Every brace and quote inside
    // the here-string would otherwise be counted.
    const body = [
      "$sql = @'",
      'IF EXISTS (SELECT 1) BEGIN',
      "    PRINT ''done''",
      'END',
      "'@",
      'Invoke-Sqlcmd -Query $sql -ErrorAction Stop',
    ].join('\n');
    expect(lintPowerShell(body)).toEqual([]);
  });

  it('reports a here-string that is never terminated', () => {
    expect(codes(lintPowerShell("$sql = @'\nSELECT 1\n"))).toContain('ps/unterminated-string');
  });

  it('reports the brace that was left open', () => {
    const found = lintPowerShell('exit 0\nif ($true) {\n    Write-Output "hi"\n');
    expect(codes(found)).toEqual(['ps/unbalanced-bracket']);
    expect(found[0]).toMatchObject({ startLine: 2 });
  });

  it('reports a closer that does not match what is open', () => {
    expect(codes(lintPowerShell('exit 0\nif ($true) { Write-Output 1 )'))).toContain(
      'ps/unbalanced-bracket',
    );
  });

  it('ignores braces inside comments and strings', () => {
    const body = ['# if ($x) {', '<# } #>', '$a = "{ not code }"', 'exit 0'].join('\n');
    expect(lintPowerShell(body)).toEqual([]);
  });

  it('catches trailing whitespace after a line-continuation backtick', () => {
    const found = lintPowerShell('exit 0\nGet-ChildItem `  \n    -Path C:\\temp');
    expect(codes(found)).toEqual(['ps/dangling-continuation']);
    expect(found[0]).toMatchObject({ severity: 'error', startLine: 2 });
  });

  it('accepts a clean line continuation', () => {
    expect(lintPowerShell('exit 0\nGet-ChildItem `\n    -Path C:\\temp')).toEqual([]);
  });
});

describe('PowerShell: output and error handling advice', () => {
  it('flags Write-Host because it never reaches the job history', () => {
    const found = lintPowerShell('exit 0\nWrite-Host "starting"');
    expect(codes(found)).toEqual(['ps/write-host']);
    expect(found[0]!.message).toContain('job history');
  });

  it('flags Invoke-Sqlcmd that will not stop on a T-SQL error', () => {
    expect(codes(lintPowerShell('exit 0\nInvoke-Sqlcmd -Query $q'))).toContain(
      'ps/sqlcmd-swallows-errors',
    );
  });

  it('follows a backtick continuation to find -ErrorAction Stop', () => {
    const body = 'exit 0\nInvoke-Sqlcmd -Query $q `\n    -ServerInstance x `\n    -ErrorAction Stop';
    expect(codes(lintPowerShell(body))).not.toContain('ps/sqlcmd-swallows-errors');
  });

  it('says nothing about Invoke-Sqlcmd once the preference is set globally', () => {
    const body = "$ErrorActionPreference = 'Stop'\nInvoke-Sqlcmd -Query $q";
    expect(lintPowerShell(body)).toEqual([]);
  });
});

/**
 * The rules run in the browser, on every keystroke, over text the operator is
 * typing. A pattern that backtracks is not a slow lint — it is a frozen tab,
 * and the input that triggers it is one somebody types by accident.
 *
 * Both cases below were real. The first was found by CodeQL and measured at
 * 790ms for 28 characters, quadrupling every further two. The second was found
 * by checking the rest of the file for the same mistake — a quantifier whose
 * character class overlaps the one before it, so the same text can be divided
 * between them more than one way.
 *
 * The bounds are enormous relative to the fixed cost (microseconds at these
 * sizes) and unreachable for the broken versions, so this is decisive without
 * being timing-flaky.
 */
describe('pathological input', () => {
  it.each([
    ['a long identifier run after WITH', `WITH ${'_'.repeat(400)}!`],
    ['a long unclosed RAISERROR argument', `RAISERROR(${' '.repeat(40_000)}!`],
    ['deeply nested brackets', `SELECT ${'('.repeat(5_000)}`],
    ['a body that is one long token', 'x'.repeat(100_000)],
  ])('lints %s in reasonable time', (_name, body) => {
    const started = performance.now();
    lintTsql(body);
    expect(performance.now() - started).toBeLessThan(1_000);
  });

  it('does not lint a body past the size cap at all', () => {
    // The last line of defence: past this the pass is skipped rather than run
    // slowly, because a generated script of this size is not one anybody is
    // hand-editing and the cost lands on typing latency.
    expect(lintStepBody('SELECT 1;'.repeat(40_000), 'sql')).toEqual([]);
  });
});

describe('summary line', () => {
  it('is null when there is nothing to report', () => {
    expect(summariseDiagnostics([])).toBeNull();
  });

  it('counts by severity and gets the plurals right', () => {
    // Deliberately not an unterminated string: that swallows the rest of the
    // body into the literal, so the later rules have nothing left to see and
    // the counts collapse to one. Correct, but useless as a fixture.
    const found = lintTsql(
      'SELECT COUNT(* FROM dbo.T;\nDELETE FROM dbo.Orders;\nSELECT * FROM t WITH (NOLOCK);',
    );
    expect(summariseDiagnostics(found)).toBe('1 error, 1 warning, 1 note');
  });
});
