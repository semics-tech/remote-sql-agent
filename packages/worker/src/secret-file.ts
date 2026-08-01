import { randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/**
 * Write a secret to disk, replacing whatever was there, without ever exposing
 * it.
 *
 * `writeFileSync(path, …, { mode })` looks like it does this and does not:
 *
 *   - It **follows symlinks**. Anything that can create `path` before the
 *     worker does gets the API key or the mTLS private key written to a
 *     location of its choosing, and `chmod` afterwards secures the wrong file.
 *   - The `mode` argument applies **only on create**. An existing file keeps
 *     its own mode, so on a rotation the new secret lands in a file that may
 *     already be world-readable, and the `chmod` that narrows it runs *after*
 *     the bytes are on disk. The window is small and entirely avoidable.
 *
 * `credential-key.ts` documents both hazards at length and uses `'wx'`. It can,
 * because it only ever creates. These callers have to replace, so the same
 * guarantee comes from writing a fresh file with `'wx'` — which the kernel
 * refuses if anything at all exists at that path, symlink included — and then
 * renaming it over the target. `rename` replaces a symlink rather than
 * following it, and is atomic, so a reader sees either the old secret or the
 * new one and never a partial write.
 */
export function writeSecretFile(path: string, contents: string, mode = 0o600): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });

  // Same directory, so the rename is within one filesystem and therefore
  // atomic. A random suffix rather than a fixed one: two workers enrolling at
  // once must not collide on it, and `wx` would make that an error rather than
  // a corruption, but an error at enrolment is still a support call.
  const temporary = join(dir, `.${randomBytes(8).toString('hex')}.tmp`);

  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', mode, flag: 'wx' });
    try {
      // Belt and braces: a restrictive umask cannot widen the mode, but it can
      // narrow it, and an explicit chmod on a file nobody else can see yet is
      // free. Not a security boundary — the `wx` above is.
      chmodSync(temporary, mode);
    } catch {
      // Windows has no POSIX modes; DPAPI protection is applied by the installer.
    }
    renameSync(temporary, path);
  } catch (err) {
    try {
      unlinkSync(temporary);
    } catch {
      // Already gone, or never created. Nothing to clean up.
    }
    throw err;
  }
}
