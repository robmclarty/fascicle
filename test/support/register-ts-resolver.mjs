/**
 * Bootstraps the `.js → .ts` resolver for child-process harnesses.
 *
 * Used via `node --import <path-to-this-file> child-harness.ts`.
 */

import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);
