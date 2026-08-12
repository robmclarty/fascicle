/**
 * ESM loader hook for the missing-`ai`-peer harness.
 *
 * Layers one behaviour on top of the shared `.js -> .ts` base resolver
 * (test/support/ts-resolver.mjs): every `ai` specifier fails to resolve, the
 * way it would on an install that never pulled the peer. Nothing is stubbed
 * here on purpose — a stub would prove the engine tolerates a fake `ai`, not
 * that it never reaches for the real one. Never imported from production
 * source.
 */

import { resolve as base_resolve } from '../../../../test/support/ts-resolver.mjs';

export async function resolve(specifier, context, next_resolve) {
  if (specifier === 'ai' || specifier.startsWith('ai/')) {
    const err = new Error(`Cannot find package 'ai' (simulated missing peer)`);
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return base_resolve(specifier, context, next_resolve);
}
