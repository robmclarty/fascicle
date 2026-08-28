import { defineConfig, devices } from '@playwright/test';

// The viewer canvas end-to-end suite: the one place the compiled app, the
// node:http server, and a real browser meet. It runs behind checkride's opt-in
// `e2e` slot rather than in `pnpm check`, because it needs both a vite build
// and a downloaded browser; `pnpm exec playwright install chromium` is the
// one-time setup.
//
// Specs are named `*.e2e.ts` so vitest's `*.{test,spec}.ts` globs never pick
// them up: two runners over one file would each half-run it.
export default defineConfig({
  testDir: './src/viewer/__tests__/e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list'], ['json', { outputFile: '.check/e2e.json' }]],
  outputDir: '.check/e2e',
  use: {
    ...devices['Desktop Chrome'],
    // The artboards are drawn at 1440x900; matching it keeps a screenshot
    // baseline comparable to the frozen visual direction.
    viewport: { width: 1440, height: 900 },
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
});
