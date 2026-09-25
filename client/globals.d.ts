/**
 * Build-time constant injected by `scripts/build-client.mjs` (esbuild `define`)
 * with this package's version. Declared so `tsc` type-checks the client half; at
 * runtime `client/version.ts` reads it behind a `typeof` guard, so a bundle built
 * without the define degrades to '0.0.0' instead of throwing.
 */
declare const __CLIENT_VERSION__: string
