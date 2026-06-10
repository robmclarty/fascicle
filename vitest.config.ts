import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^fascicle\/adapters$/,
        replacement: fileURLToPath(new URL('./packages/fascicle/src/adapters.ts', import.meta.url)),
      },
      {
        find: /^fascicle$/,
        replacement: fileURLToPath(new URL('./packages/fascicle/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: [
      'packages/*/src/**/*.{test,spec}.ts',
      'packages/*/test/**/*.{test,spec}.ts',
      'test/**/*.{test,spec}.ts',
      // pr-improve worktree-scoped builder tools (Phase C, PR A) +
      // builder dispatch test (Phase C, PR B).
      // Coverage thresholds intentionally still scoped to packages/*.
      'examples/pr-improve/src/tools/**/*.{test,spec}.ts',
      'examples/pr-improve/src/stages/**/*.{test,spec}.ts',
    ],
    pool: 'forks',
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: [
        'packages/*/src/**/*.{test,spec}.ts',
        'packages/*/src/**/*.d.ts',
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
