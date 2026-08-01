import { describe, expect, it } from 'vitest';
import {
  canonicaliseJob,
  canonicaliseJobWithHash,
  hashCanonical,
  normaliseText,
  parseJobDefinition,
  canonicalJsonStringify,
} from '../src/canonical.js';
import { job, step, schedule } from './fixtures.js';

describe('normaliseText', () => {
  it('converts CRLF and lone CR to LF', () => {
    expect(normaliseText('a\r\nb\rc')).toBe('a\nb\nc');
  });

  it('strips trailing whitespace per line', () => {
    expect(normaliseText('SELECT 1;   \n  FROM t\t\n')).toBe('SELECT 1;\n  FROM t');
  });

  it('strips trailing blank lines but preserves leading and interior ones', () => {
    expect(normaliseText('\n\na\n\nb\n\n\n')).toBe('\n\na\n\nb');
  });

  it('leaves already-normal text untouched', () => {
    expect(normaliseText('SELECT 1;')).toBe('SELECT 1;');
  });
});

describe('canonicaliseJob', () => {
  it('is stable regardless of key insertion order', () => {
    const a = job();
    // Rebuild with keys in a deliberately different order.
    const b = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(canonicaliseJob(b)).toBe(canonicaliseJob(a));
  });

  it('emits keys in lexicographic order', () => {
    const json = canonicaliseJob(job());
    const keys = Object.keys(JSON.parse(json) as Record<string, unknown>);
    expect(keys).toEqual([...keys].sort());
  });

  it('produces no insignificant whitespace', () => {
    expect(canonicaliseJob(job())).not.toMatch(/:\s|,\s/u);
  });

  it('sorts steps by stepId, not array position', () => {
    const forwards = job({ steps: [step({ stepId: 1 }), step({ stepId: 2, name: 'Second' })] });
    const backwards = job({ steps: [step({ stepId: 2, name: 'Second' }), step({ stepId: 1 })] });
    expect(canonicaliseJob(backwards)).toBe(canonicaliseJob(forwards));
  });

  it('sorts schedules by name', () => {
    const a = job({ schedules: [schedule({ name: 'A' }), schedule({ name: 'B' })] });
    const b = job({ schedules: [schedule({ name: 'B' }), schedule({ name: 'A' })] });
    expect(canonicaliseJob(a)).toBe(canonicaliseJob(b));
  });

  it('treats line-ending differences in step bodies as equivalent', () => {
    const unix = job({ steps: [step({ command: 'SELECT 1;\nSELECT 2;' })] });
    const windows = job({ steps: [step({ command: 'SELECT 1;\r\nSELECT 2;' })] });
    expect(canonicaliseJob(windows)).toBe(canonicaliseJob(unix));
  });

  it('treats a real change to a step body as a change', () => {
    const before = job({ steps: [step({ command: 'SELECT 1;' })] });
    const after = job({ steps: [step({ command: 'SELECT 2;' })] });
    expect(canonicaliseJob(after)).not.toBe(canonicaliseJob(before));
  });

  it('rejects a job that does not satisfy the schema', () => {
    expect(() => canonicaliseJob({ ...job(), name: '' })).toThrow();
    expect(() => canonicaliseJob({ ...job(), schemaVersion: 'JobDefinition.v2' })).toThrow();
  });

  it('round-trips through parseJobDefinition unchanged', () => {
    const { canonicalJson } = canonicaliseJobWithHash(job());
    expect(canonicaliseJob(parseJobDefinition(canonicalJson))).toBe(canonicalJson);
  });

  it('does not quote the input when it will not parse', () => {
    // V8's own SyntaxError reads `Unexpected token 's', "sqlcmd -S "... is not
    // valid JSON` — ten characters of a step body, in a message that travels
    // to the worker's errorDetail, the control plane's audit row, and the SIEM
    // from there. Step bodies routinely carry connection strings.
    const malformed = 'sqlcmd -S prod01 -U sa -P Hunter2!';

    expect(() => parseJobDefinition(malformed)).toThrow(/not valid JSON/u);
    try {
      parseJobDefinition(malformed);
      expect.unreachable('should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain('sqlcmd');
      expect(message).not.toContain('Hunter2');
    }
  });
});

describe('hashing', () => {
  it('is a stable sha256 of the canonical bytes', () => {
    const { canonicalJson, hash } = canonicaliseJobWithHash(job());
    expect(hash).toBe(hashCanonical(canonicalJson));
    expect(hash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is identical across independent canonicalisations of an equivalent job', () => {
    // This is the property the whole drift-detection design rests on: the
    // worker and the control plane must derive the same hash from the same job.
    const fromWorker = canonicaliseJobWithHash(job({ steps: [step({ command: 'SELECT 1;\r\n' })] }));
    const fromServer = canonicaliseJobWithHash(job({ steps: [step({ command: 'SELECT 1;' })] }));
    expect(fromWorker.hash).toBe(fromServer.hash);
  });

  it('changes when any semantically meaningful field changes', () => {
    const base = canonicaliseJobWithHash(job()).hash;
    const variants = [
      job({ name: 'Renamed' }),
      job({ enabled: false }),
      job({ startStepId: 2 }),
      job({ ownerLoginName: 'someone_else' }),
      job({ notifications: { ...job().notifications, emailLevel: 3 } }),
      job({ steps: [step({ retryAttempts: 3 })] }),
      job({ schedules: [schedule({ activeStartTime: 30000 })] }),
    ];
    for (const v of variants) {
      expect(canonicaliseJobWithHash(v).hash, JSON.stringify(v.name)).not.toBe(base);
    }
  });
});

describe('canonicalJsonStringify', () => {
  it('sorts keys at every level of nesting', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('preserves array order', () => {
    expect(canonicalJsonStringify({ a: [3, 1, 2] })).toBe('{"a":[3,1,2]}');
  });

  it('normalises negative zero', () => {
    expect(canonicalJsonStringify({ a: -0 })).toBe('{"a":0}');
  });

  it('refuses non-finite numbers rather than silently emitting null', () => {
    expect(() => canonicalJsonStringify({ a: Number.NaN })).toThrow(/non-finite/iu);
    expect(() => canonicalJsonStringify({ a: Infinity })).toThrow(/non-finite/iu);
  });

  it('skips undefined rather than letting JSON.stringify drop it silently', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });
});
