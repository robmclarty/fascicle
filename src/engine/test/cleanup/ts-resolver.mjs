/**
 * ESM loader hook for the engine SIGINT harness.
 *
 * Two behaviors:
 *   1. Maps `.js` import specifiers to their `.ts` siblings on disk (same as
 *      the core harness) so the engine substrate compiles inline.
 *   2. Remaps the bare specifier `ai` to a local stub that returns an
 *      abort-aware hanging stream — the SIGINT test needs a deterministic
 *      in-flight provider call without touching the network. The registry
 *      stays untouched; the stub adapter is provided via a fake `@robmclarty`
 *      specifier? No — we leave the registry alone and rely on the real
 *      Anthropic adapter's `build_model` loading the real `@ai-sdk/anthropic`
 *      peer, but `generateText` / `streamText` from `ai` are replaced so no
 *      actual HTTP is attempted.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolve_path } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ai_stub_path = resolve_path(here, 'ai-stub.mjs');
const sdk_stub_path = resolve_path(here, 'sdk-stub.mjs');

export async function resolve(specifier, context, next_resolve) {
  if (specifier === 'ai') {
    return { url: `file://${ai_stub_path}`, format: 'module', shortCircuit: true };
  }
  if (specifier === '@ai-sdk/anthropic') {
    return { url: `file://${sdk_stub_path}`, format: 'module', shortCircuit: true };
  }
  if (
    specifier.endsWith('.js') &&
    (specifier.startsWith('./') || specifier.startsWith('../')) &&
    context.parentURL?.startsWith('file:')
  ) {
    const parent_path = fileURLToPath(context.parentURL);
    const ts_sibling = resolve_path(dirname(parent_path), `${specifier.slice(0, -3)}.ts`);
    if (existsSync(ts_sibling)) {
      return next_resolve(`${specifier.slice(0, -3)}.ts`, context);
    }
  }
  return next_resolve(specifier, context);
}
