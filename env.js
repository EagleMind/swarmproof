'use strict'

/**
 * Loads .env into process.env.
 *
 * This exists as its own module rather than a line at the top of the server
 * because ES module imports are hoisted: any statement in a module body runs
 * *after* every module it imports has already been evaluated. server.js
 * reads ENGINE_HOST and ENGINE_ALLOW_PUBLIC at module scope, so a
 * `process.loadEnvFile()` sitting above those reads would still have run too
 * late — and the token would always have looked unset, which is the failure
 * that matters: the server would refuse to bind a configured public address.
 *
 * Imported first, it evaluates first — module evaluation follows import
 * order — and the key is in place before anything reads it.
 */

try {
  process.loadEnvFile()
} catch {
  // No .env is a perfectly good setup: every provider except TMDb is keyless.
}
