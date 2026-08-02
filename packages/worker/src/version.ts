/**
 * The worker's own version, baked in at build time.
 *
 * Not read from package.json at runtime: the shipped `.mjs` bundle and the
 * SEA executable both carry nothing beside them, by design (CONTRIBUTING.md),
 * so there is no package.json alongside a running worker to read. Kept in
 * step with the workspace version by `scripts/set-version.ts` instead — this
 * is the one place in the worker that needs to know it.
 */
export const WORKER_VERSION = '0.2.0';
