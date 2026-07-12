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
    low: 83,
    // Ratchet: the real score sits at ~86.8% (clean full-repo gate after the
    // anthropic_native.ts hardening lifted that file 73.9% -> 98.2%, on top of the
    // earlier native-provider + otel work: openai_compatible_native/ollama_native
    // ~96.5%, trajectory_logger 93%, telemetry 100%, with_providers 97.6%), so the
    // gate floor is raised from 82 to 83. ~3.8 points of headroom absorb the
    // timing-sensitive spawn/timeout/map suites (91 Timeout mutants count as killed
    // and can flip on a slow run). Bump it further as coverage climbs; never lower
    // it to make a failing run pass.
    break: 83,
  },
  tempDirName: '.stryker-tmp',
  cleanTempDir: true,
};
