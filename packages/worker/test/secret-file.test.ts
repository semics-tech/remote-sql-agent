import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { writeSecretFile } from '../src/secret-file.js';

/**
 * How the worker's API key and mTLS private key reach disk.
 *
 * `writeFileSync(path, …, { mode })` looks like it does this safely and does
 * not: it follows symlinks, and its `mode` applies only when it creates the
 * file. `credential-key.ts` documents both hazards at length and avoids them
 * with `'wx'`; these two callers did not, and they write the material that
 * authenticates the worker to the control plane.
 */

const dir = mkdtempSync(join(tmpdir(), 'rsagent-secret-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fresh(name: string): string {
  return join(dir, `${name}-${Math.random().toString(36).slice(2)}`);
}

describe('writeSecretFile', () => {
  it('writes the contents and creates the directory', () => {
    const path = join(fresh('nested'), 'sub', 'worker.key');
    writeSecretFile(path, 'rsak_secret\n');
    expect(readFileSync(path, 'utf8')).toBe('rsak_secret\n');
  });

  it('replaces an existing secret, which is what a rotation does', () => {
    const path = fresh('rotate');
    writeSecretFile(path, 'first');
    writeSecretFile(path, 'second');
    expect(readFileSync(path, 'utf8')).toBe('second');
  });

  it.skipIf(process.platform === 'win32')('leaves the file readable only by its owner', () => {
    const path = fresh('mode');
    writeSecretFile(path, 'secret');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it.skipIf(process.platform === 'win32')(
    'narrows a file that was already there and world-readable',
    () => {
      // The rotation hazard. `writeFileSync`'s mode applies only on create, so
      // the new secret used to land in the *old* file's mode and be narrowed by
      // a chmod afterwards — a window in which the bytes were on disk and
      // readable. Renaming a fresh 0600 file over the top has no such window.
      const path = fresh('widened');
      writeFileSync(path, 'old');
      chmodSync(path, 0o644);

      writeSecretFile(path, 'new');

      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(readFileSync(path, 'utf8')).toBe('new');
    },
  );

  it.skipIf(process.platform === 'win32')('replaces a symlink instead of writing through it', () => {
    // The one that matters. Anything able to create `path` before the worker
    // does could point it at a location of its choosing and receive the API
    // key or the mTLS private key — with the chmod afterwards securing the
    // wrong file entirely.
    const target = fresh('attacker-target');
    writeFileSync(target, 'attacker can read this');
    const path = fresh('link');
    symlinkSync(target, path);

    writeSecretFile(path, 'rsak_secret');

    expect(readFileSync(path, 'utf8')).toBe('rsak_secret');
    // The secret did not follow the link.
    expect(readFileSync(target, 'utf8')).toBe('attacker can read this');
  });

  it('leaves no temporary file behind', () => {
    const path = join(dir, 'leftovers', 'worker.key');
    writeSecretFile(path, 'secret');
    const stray = readdirSync(join(dir, 'leftovers')).filter((f) => f.endsWith('.tmp'));
    expect(stray).toEqual([]);
  });

  it('cleans up its temporary file when the write cannot complete', () => {
    // A directory in place of the destination makes `rename` fail after the
    // temp file exists — the path that would otherwise leak a copy of the
    // secret into the run directory on every failed attempt.
    const path = join(dir, 'as-a-directory');
    rmSync(path, { recursive: true, force: true });
    mkdirSync(path);

    expect(() => writeSecretFile(path, 'secret')).toThrow();
    const stray = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(stray).toEqual([]);
    expect(existsSync(path)).toBe(true);
  });
});
