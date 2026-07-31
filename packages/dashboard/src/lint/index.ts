import { MAX_LINTED_LENGTH, type Diagnostic } from './diagnostics.js';
import { lintPowerShell } from './powershell.js';
import { lintTsql } from './tsql.js';

export type { Diagnostic, Severity } from './diagnostics.js';
export { lintPowerShell } from './powershell.js';
export { lintTsql } from './tsql.js';

/**
 * Lint a step body for the editor's language.
 *
 * Only the two languages with a real subsystem behind them are linted. CmdExec
 * bodies are a command line and SSIS steps are a package path: there is nothing
 * to check that would not be guessing.
 */
export function lintStepBody(text: string, language: string): Diagnostic[] {
  if (text.length > MAX_LINTED_LENGTH) return [];
  if (language === 'sql') return lintTsql(text);
  if (language === 'powershell') return lintPowerShell(text);
  return [];
}

export interface DiagnosticCounts {
  errors: number;
  warnings: number;
  infos: number;
}

export function countDiagnostics(diagnostics: Diagnostic[]): DiagnosticCounts {
  return {
    errors: diagnostics.filter((d) => d.severity === 'error').length,
    warnings: diagnostics.filter((d) => d.severity === 'warning').length,
    infos: diagnostics.filter((d) => d.severity === 'info').length,
  };
}

/** "2 errors, 1 warning" — or null when there is nothing to say. */
export function summariseDiagnostics(diagnostics: Diagnostic[]): string | null {
  const { errors, warnings, infos } = countDiagnostics(diagnostics);
  const parts: string[] = [];
  if (errors > 0) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings > 0) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (infos > 0) parts.push(`${infos} ${infos === 1 ? 'note' : 'notes'}`);
  return parts.length === 0 ? null : parts.join(', ');
}
