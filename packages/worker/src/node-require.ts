// Namespace import, not `import { createRequire }`. The ESM bundle's banner
// declares its own createRequire, and esbuild emits both as top-level bindings
// with the same name — which is a SyntaxError the moment the file is run, and
// nothing catches it before that: the bundle builds clean and the error only
// appears when someone executes what npm installed.
import * as nodeModule from 'node:module';

/**
 * A `require` that works in all three shapes the worker runs as.
 *
 * The worker is executed as ES modules under tsx in development, as an ESM
 * bundle from npm, and as a CommonJS bundle embedded in a single executable.
 * Only the first has a usable `import.meta.url`: esbuild replaces it with
 * `undefined` when it emits CommonJS, and inside a single executable there is
 * no module path to speak of — `__filename` is the executable itself.
 *
 * Getting this wrong does not fail the build. It fails at the first line of
 * `main()`, in the shipped binary only, with an error that names neither
 * SQLite nor argv.
 */
export const nodeRequire = nodeModule.createRequire(
  typeof __filename === 'string' ? __filename : import.meta.url,
);
