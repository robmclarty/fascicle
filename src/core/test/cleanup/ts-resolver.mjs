/**
 * ESM loader hook for child-process harnesses.
 *
 * Node 24 natively type-strips `.ts` files, but does not remap `.js` import
 * specifiers to their `.ts` sibling on disk. The substrate sources use `.js`
 * specifiers (the TS ESM convention), so a `.ts` child script importing from
 * the substrate would fail module resolution without this hook.
 *
 * This file is used only by SIGINT harness children under
 * `packages/core/test/cleanup/`. It is never imported from production source.
 */

import { existsSync } from 'node:fs';
import { dirname, resolve as resolve_path } from 'node:path';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next_resolve) {
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
