/**
 * ESM loader hook for the engine SIGINT harness.
 *
 * Layers two engine-specific stubs on top of the shared `.js -> .ts` base
 * resolver (test/support/ts-resolver.mjs):
 *   - `ai` -> a local stub that returns an abort-aware hanging stream, so the
 *     SIGINT test has a deterministic in-flight provider call without touching
 *     the network.
 *   - `@ai-sdk/anthropic` -> a local stub, so the real Anthropic adapter's
 *     `build_model` resolves without the real peer.
 * Everything else (including `.js -> .ts` sibling remapping) delegates to the
 * shared base. Never imported from production source.
 */

import { dirname, resolve as resolve_path } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolve as base_resolve } from '../../../../test/support/ts-resolver.mjs';

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
  return base_resolve(specifier, context, next_resolve);
}
