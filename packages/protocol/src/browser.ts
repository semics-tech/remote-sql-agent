/**
 * Browser-safe surface of the contracts package.
 *
 * The main entry point pulls in `node:crypto` (hashing, command signing) and
 * `@grpc/grpc-js`, neither of which can be bundled for a browser. The dashboard
 * needs the *shape* of the domain — job/schedule types, schedule decoding, the
 * capability and role model — and none of the transport or crypto.
 *
 * Keeping that split explicit here means a stray import of the wrong thing
 * fails at build time rather than shipping a broken bundle.
 */
export * from './job-definition.js';
export * from './job-edit.js';
export * from './job-flow.js';
export * from './job-write.js';
export * from './schedule.js';
export * from './capabilities.js';
export * from './roles.js';
export * from './history-scrub.js';
