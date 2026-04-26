/**
 * Stryker mutation testing config.
 *
 * Invoked by the `mutation` step of `scripts/check.mjs` (and directly via
 * `pnpm check:mutation`). Incremental mode keeps re-runs cheap — the shared
 * baseline at `stryker.incremental.json` is committed so every contributor
 * and CI start from the same state.
 */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: '.check/mutation/report.html' },
  jsonReporter: { fileName: '.check/mutation.json' },
  mutate: ['packages/*/src/**/*.ts', '!packages/*/src/**/*.test.ts', '!packages/*/src/**/*.spec.ts'],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'stryker.incremental.json',
  thresholds: {
    high: 80,
    low: 60,
    break: 50,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
