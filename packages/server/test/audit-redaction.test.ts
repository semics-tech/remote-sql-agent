import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { auditablePayload } from '../src/domain/commands.js';

/**
 * What a command payload is allowed to leave behind in the audit trail.
 *
 * CLAUDE.md: "Never log step bodies, canonical JSON, or passwords. Step bodies
 * routinely contain connection strings." The pino config redacts
 * `*.canonicalJson` for exactly this reason — but `writeAudit` writes to a
 * table, never passes through pino, and `audit-export` then JSON.stringifies
 * the whole `detail` into an OTLP attribute and ships it to the configured
 * SIEM. So the redaction has to happen here, at the point the row is built.
 */

const CONNECTION_STRING = 'Server=prod01;User Id=sa;Password=Hunter2!;';

const DEFINITION = JSON.stringify({
  name: 'Nightly Backup',
  steps: [{ stepId: 1, command: `sqlcmd -S "${CONNECTION_STRING}" -Q "BACKUP DATABASE..."` }],
});

describe('auditablePayload', () => {
  it('drops the definition and keeps its hash', () => {
    const detail = auditablePayload({
      jobUuid: '11111111-1111-4111-8111-111111111111',
      canonicalJson: DEFINITION,
      baseDefinitionHash: 'sha256:abc',
      allowOverwrite: false,
    });

    expect(detail.canonicalJson).toBeUndefined();
    // The hash is what an auditor actually correlates against — it matches a
    // version in the timeline without the trail becoming a second copy of
    // every step body.
    expect(detail.definitionHash).toBe(createHash('sha256').update(DEFINITION).digest('hex'));
    expect(detail.definitionBytes).toBe(Buffer.byteLength(DEFINITION));
    expect(detail.jobUuid).toBe('11111111-1111-4111-8111-111111111111');
    expect(detail.baseDefinitionHash).toBe('sha256:abc');
    expect(detail.allowOverwrite).toBe(false);
  });

  it('leaves no trace of a password anywhere in the serialised detail', () => {
    // Serialised, because that is exactly what audit-export does before
    // shipping it: a nested field would pass a shallow key check and still go.
    const serialised = JSON.stringify(auditablePayload({ canonicalJson: DEFINITION }));
    expect(serialised).not.toContain('Hunter2');
    expect(serialised).not.toContain('sqlcmd');
    expect(serialised).not.toContain('Password');
  });

  it('excludes an unrecognised field rather than passing it through', () => {
    // The allowlist is the point. A payload field added for a new command kind
    // must be excluded until somebody decides it is safe, not published to the
    // SIEM the moment it is introduced.
    const detail = auditablePayload({
      jobUuid: 'u',
      somethingNewAndUnreviewed: CONNECTION_STRING,
    });

    expect(detail.somethingNewAndUnreviewed).toBeUndefined();
    expect(detail.jobUuid).toBe('u');
  });

  it('keeps the operator-facing fields of the non-definition commands', () => {
    expect(auditablePayload({ jobUuid: 'u', enabled: false })).toEqual({
      jobUuid: 'u',
      enabled: false,
    });
    expect(auditablePayload({ jobUuid: 'u', stepName: 'Backup' })).toEqual({
      jobUuid: 'u',
      stepName: 'Backup',
    });
    expect(auditablePayload({ jobUuid: 'u', jobName: 'Nightly', allowed: true })).toEqual({
      jobUuid: 'u',
      jobName: 'Nightly',
      allowed: true,
    });
  });

  it('survives a payload that is not an object', () => {
    expect(auditablePayload(null)).toEqual({});
    expect(auditablePayload('a string')).toEqual({});
    expect(auditablePayload(undefined)).toEqual({});
  });
});
