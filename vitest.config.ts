import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      { find: /^#core$/, replacement: fileURLToPath(new URL('./src/core/index.ts', import.meta.url)) },
      { find: /^#engine$/, replacement: fileURLToPath(new URL('./src/engine/index.ts', import.meta.url)) },
      { find: /^#composites$/, replacement: fileURLToPath(new URL('./src/composites/index.ts', import.meta.url)) },
      { find: /^#adapters$/, replacement: fileURLToPath(new URL('./src/adapters/index.ts', import.meta.url)) },
      { find: /^#viewer$/, replacement: fileURLToPath(new URL('./src/viewer/index.ts', import.meta.url)) },
      { find: /^#agents$/, replacement: fileURLToPath(new URL('./src/agents/index.ts', import.meta.url)) },
      { find: /^#stdio$/, replacement: fileURLToPath(new URL('./src/stdio/index.ts', import.meta.url)) },
      { find: /^#acp$/, replacement: fileURLToPath(new URL('./src/acp/index.ts', import.meta.url)) },
      { find: /^#ui$/, replacement: fileURLToPath(new URL('./src/ui/index.ts', import.meta.url)) },
      { find: /^#policy$/, replacement: fileURLToPath(new URL('./src/policy/index.ts', import.meta.url)) },
      { find: /^#schema$/, replacement: fileURLToPath(new URL('./src/schema/index.ts', import.meta.url)) },
      { find: /^#testing$/, replacement: fileURLToPath(new URL('./src/testing/index.ts', import.meta.url)) },
      // Published surface (examples + doc snippets import these names).
      { find: /^fascicle\/acp$/, replacement: fileURLToPath(new URL('./src/acp/index.ts', import.meta.url)) },
      { find: /^fascicle\/adapters$/, replacement: fileURLToPath(new URL('./src/adapters/index.ts', import.meta.url)) },
      { find: /^fascicle\/mcp$/, replacement: fileURLToPath(new URL('./src/mcp/index.ts', import.meta.url)) },
      { find: /^fascicle\/otel$/, replacement: fileURLToPath(new URL('./src/otel/index.ts', import.meta.url)) },
      { find: /^fascicle\/stdio$/, replacement: fileURLToPath(new URL('./src/stdio/index.ts', import.meta.url)) },
      { find: /^fascicle\/ui$/, replacement: fileURLToPath(new URL('./src/ui/index.ts', import.meta.url)) },
      { find: /^fascicle\/viewer$/, replacement: fileURLToPath(new URL('./src/viewer/index.ts', import.meta.url)) },
      { find: /^fascicle\/agents$/, replacement: fileURLToPath(new URL('./src/agents/index.ts', import.meta.url)) },
      { find: /^fascicle\/testing$/, replacement: fileURLToPath(new URL('./src/testing/index.ts', import.meta.url)) },
      { find: /^fascicle$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      // The examples are demo code, but their tests are stub-engine driven and
      // hit no network, so they run in the default suite: an example that no
      // longer matches the library is a docs bug that ships. Every example app
      // colocates tests in `__tests__/`, so these two globs cover all of them
      // and a new app is picked up without editing this list.
      'examples/*/src/**/__tests__/**/*.{test,spec}.ts',
      'examples/agents/**/__tests__/**/*.{test,spec}.ts',
    ],
    pool: 'forks',
    // A worker thread that the source starts (fascicle/acp's search worker)
    // loads outside vite's module runner, so Node resolves its imports, and
    // Node strips types without mapping the sources' `.js` specifiers to
    // their `.ts` files. Each test worker, Stryker's included, registers the
    // resolver the spawn harnesses use, and the threads it starts inherit it.
    execArgv: ['--import', fileURLToPath(new URL('./test/support/register-ts-resolver.mjs', import.meta.url))],
    // Off inside Stryker's workers. Its sandbox links node_modules, so all of
    // them share vitest's module cache there, and vitest wipes that cache when
    // the lockfile changes: the first mutation run after a dependency change
    // had every worker deleting the same directory at once (ENOTEMPTY).
    fsModuleCache: process.env['STRYKER_MUTATOR_WORKER'] === undefined,
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/**/*.{test,spec}.ts',
        'src/**/*.d.ts',
        // Cross-cutting test dirs (harnesses, fixtures, integration) are not
        // module source; keep coverage scoped to real implementation files.
        'src/**/test/**',
        'src/**/__tests__/**',
      ],
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: '.check/coverage',
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
      },
    },
  },
});
