/**
 * Stryker mutation testing config.
 *
 * Invoked by the `mutation` step of `scripts/check.mjs` (and directly via
 * `pnpm check:mutation`). Incremental mode keeps re-runs cheap. The baseline at
 * `stryker.incremental.json` is gitignored; CI carries it forward across runs
 * via actions/cache (see .github/workflows/ci.yml), and local runs regenerate
 * it on first invocation.
 */
export default {
  packageManager: 'pnpm',
  testRunner: 'vitest',
  plugins: ['@stryker-mutator/vitest-runner'],
  reporters: ['clear-text', 'html', 'json'],
  htmlReporter: { fileName: '.check/mutation/report.html' },
  jsonReporter: { fileName: '.check/mutation.json' },
  mutate: [
    'src/**/*.ts',
    '!src/**/*.test.ts',
    '!src/**/*.spec.ts',
    '!src/**/test/**',
    '!src/**/__tests__/**',
    // CLI entry points: process/argv/IO glue, exercised by running the binary,
    // not by unit tests. Mutating them only yields no-coverage noise.
    '!src/viewer/cli.ts',
    '!src/viewer/start_viewer.ts',
  ],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'stryker.incremental.json',
  thresholds: {
    high: 85,
    low: 78,
    // Ratchet: the real score sits at ~81.4% (clean full-repo gate after the
    // judges/spawn/server/researcher/sandbox/combinator/generate mutation work),
    // so the gate floor is raised to 78. A few points of headroom absorb the
    // timing-sensitive spawn/timeout/map suites. Bump it further as coverage
    // climbs; never lower it to make a failing run pass.
    break: 78,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
