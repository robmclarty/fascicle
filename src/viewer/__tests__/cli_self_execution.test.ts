/**
 * Regression: the umbrella `dist/index.js` inlines packages/viewer/src/cli.ts.
 * A previous self-execution guard used `process.argv[1].endsWith('/cli.js')`,
 * which fired any time a downstream consumer's own entry script happened to
 * be named `cli.js`/`cli.ts` — silently hijacking the import to start the
 * viewer. The fix compares argv[1] against `fileURLToPath(import.meta.url)`.
 *
 * This test guards the bundled output: spawn `node` with argv[1] set to a
 * path ending in `/cli.js`, import the built `dist/index.js`, and assert
 * (a) no `fascicle-viewer:` text leaks to stderr (the CLI never auto-ran)
 * and (b) the module exposes the expected named exports.
 *
 * Skipped when `dist/index.js` is missing (unit-test runs without a build).
 * `pnpm check:all` builds first, so CI always exercises this.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const here = dirname(fileURLToPath(import.meta.url))
const DIST_INDEX = resolve(here, '../../../../dist/index.js')

type SpawnOutcome = {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
}

function spawn_probe(script: string, fake_argv1: string): Promise<SpawnOutcome> {
  return new Promise((resolve_outcome, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        script,
        fake_argv1,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', (code) => { resolve_outcome({ code, stdout, stderr }) })
  })
}

describe('viewer cli self-execution guard (regression)', () => {
  if (!existsSync(DIST_INDEX)) {
    it.skip('requires dist/index.js (run `pnpm build` first)', () => {})
    return
  }

  it('does not auto-run when imported with argv[1] ending in /cli.js', async () => {
    const dist_url = pathToFileURL(DIST_INDEX).href
    const script = `
      const mod = await import(${JSON.stringify(dist_url)});
      const names = ['start_viewer', 'run_viewer_cli'];
      const missing = names.filter((n) => typeof mod[n] !== 'function');
      if (missing.length > 0) {
        process.stderr.write('missing exports: ' + missing.join(',') + '\\n');
        process.exit(2);
      }
      process.stdout.write('imported-ok\\n');
    `
    const outcome = await spawn_probe(script, '/some/consumer/path/cli.js')
    expect(outcome.stderr).not.toMatch(/fascicle-viewer:/)
    expect(outcome.stdout).toContain('imported-ok')
    expect(outcome.code).toBe(0)
  }, 15_000)
})
