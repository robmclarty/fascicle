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
    // Same reasoning: process glue (stdin/stdout/exit) exercised by the
    // spawn-based contract tests in src/stdio/__tests__/e2e/, not unit tests.
    '!src/stdio/run_stdio.ts',
  ],
  coverageAnalysis: 'perTest',
  incremental: true,
  incrementalFile: 'stryker.incremental.json',
  thresholds: {
    high: 85,
    low: 84,
    // Ratchet: the real score sits at 88.33% (clean full-repo gate after hardening
    // the shared orchestration core: generate.ts 77.6% -> 95.79% and tool_loop.ts
    // 83.7% -> 94.59%, on top of the anthropic_native.ts hardening (73.9% -> 98.2%)
    // and the earlier native-provider + otel work), so the gate floor is raised from
    // 83 to 84. ~4.3 points of headroom absorb the timing-sensitive spawn/timeout/map
    // suites (91 Timeout mutants count as killed and can flip on a slow run). Bump it
    // further as coverage climbs; never lower it to make a failing run pass.
    break: 84,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
