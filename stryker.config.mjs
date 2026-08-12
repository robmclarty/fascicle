/**
 * Stryker mutation testing config.
 *
 * Invoked by checkride's opt-in `mutation` slot (and directly via
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
    // `high` and `low` only colour the report; `break` is the only gate that
    // fails a run.
    high: 90,
    low: 86,
    // Ratchet: the real score sits at 89.00% (clean full-repo gate after closing
    // the last un-hardened wire adapter, providers/anthropic.ts 66.1% -> 100%),
    // so the floor is raised from 84 to 86.
    //
    // Headroom is sized from the measured flake surface, not a guess. Only
    // Timeout mutants can flip on a slow run, and there are 91 of 10677 scored
    // = 0.85pt worst case if every one flipped at once. 3 points is ~3.5x that,
    // which is why this step is +2 rather than the +1 of earlier ratchets: the
    // old comment justified ~4.3pt with the same 91 Timeouts, overestimating
    // their weight by roughly 5x. Bump further as coverage climbs; never lower
    // it to make a failing run pass.
    break: 86,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
