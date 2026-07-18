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
      { find: /^#ui$/, replacement: fileURLToPath(new URL('./src/ui/index.ts', import.meta.url)) },
      // Published surface (examples + doc snippets import these names).
      { find: /^fascicle\/adapters$/, replacement: fileURLToPath(new URL('./src/adapters/index.ts', import.meta.url)) },
      { find: /^fascicle\/mcp$/, replacement: fileURLToPath(new URL('./src/mcp/index.ts', import.meta.url)) },
      { find: /^fascicle\/stdio$/, replacement: fileURLToPath(new URL('./src/stdio/index.ts', import.meta.url)) },
      { find: /^fascicle\/ui$/, replacement: fileURLToPath(new URL('./src/ui/index.ts', import.meta.url)) },
      { find: /^fascicle\/agents$/, replacement: fileURLToPath(new URL('./src/agents/index.ts', import.meta.url)) },
      { find: /^fascicle$/, replacement: fileURLToPath(new URL('./src/index.ts', import.meta.url)) },
    ],
  },
  test: {
    include: [
      'src/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      // pr-improve worktree-scoped builder tools (Phase C, PR A) +
      // builder dispatch test (Phase C, PR B).
      'examples/pr-improve/src/tools/**/*.{test,spec}.ts',
      'examples/pr-improve/src/stages/**/*.{test,spec}.ts',
      // Reference agents are demo code, but their behavior tests (stub-engine
      // driven, no network) still run so the examples cannot rot silently.
      'examples/agents/**/__tests__/**/*.{test,spec}.ts',
    ],
    pool: 'forks',
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
