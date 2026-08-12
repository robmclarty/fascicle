/**
 * Bootstraps the missing-`ai`-peer harness ESM resolver hook.
 *
 * Used via `node --import <path-to-this-file> child-harness.ts`.
 */

import { register } from 'node:module';

register('./ts-resolver.mjs', import.meta.url);
