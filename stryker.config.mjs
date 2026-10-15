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
    // CLI entry point: process glue (stdin/stdout/exit) exercised by the
    // spawn-based contract tests in src/stdio/__tests__/e2e/, not unit tests.
    '!src/stdio/run_stdio.ts',
    // serve_acp's process glue (the console reroute, stdin and stdout, the
    // signal exit), exercised by the spawn tests in src/acp/__tests__/e2e/.
    // The serving loop and its disconnect path live in src/acp/serve_streams.ts,
    // which is mutated like any other module.
    '!src/acp/serve_acp.ts',
    // The fascicle-diagram bin's process glue (real streams, the EPIPE guard,
    // loading through the project's tsx), exercised by the spawn-based tests
    // in src/__tests__/diagram_bin.test.ts. The command's decisions live in
    // src/diagram_cli.ts, which is mutated like any other module.
    '!src/diagram_bin.ts',
    // The flow schema is a JSON Schema document held in a TypeScript module
    // only so tsgo can declare it (see the file's header). It was a .json file
    // until then, outside `src/**/*.ts`, and it is still data: mutating its
    // strings would score the document's wording, not any decision.
    '!src/core/flow_schema.ts',
    // The viewer canvas app splits along D4: `app/lib/*.ts` and `app/sse.ts`
    // hold every decision and are mutated like any other module, while the
    // `.tsx` components are markup and fall outside `src/**/*.ts` by
    // construction. Mutating DOM structure under jsdom would be slow noise
    // that the Playwright screenshot suite covers better; the file extension
    // is the exclusion, and this is the ledger entry for it. The Playwright
    // specs themselves are already excluded as `src/**/__tests__/**`.
  ],
  coverageAnalysis: 'perTest',
  // No such file, on purpose. Stryker rewrites the tsconfig chain in its sandbox
  // through TypeScript's JavaScript API, which TypeScript 7 no longer ships, so
  // the rewrite crashes the run (`ts.parseConfigFileTextToJson is not a
  // function`). The vitest runner never reads those tsconfigs, and Stryker skips
  // the rewrite when it can't find the file.
  tsconfigFile: 'tsconfig.stryker-skip.json',
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
