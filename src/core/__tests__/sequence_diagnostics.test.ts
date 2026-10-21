import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The repo root, three levels above this file's folder.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const MISWIRED = `import { sequence, step } from 'fascicle'

type Pair = { a: number; b: number }

const add = step('add', ({ a, b }: Pair) => a + b)
const double = step('double', (n: number) => n * 2)
const say = step('say', (n: number) => \`the answer is \${n}\`)

export const flow = sequence([add, say, double])
`

/**
 * Type-check one source file against the library, the way a consumer's
 * compiler sees it, and return the diagnostics that tsc prints.
 *
 * The message is the thing under test, and only a compiler run can show it:
 * a call that matches no overload is reported against the last one, so which
 * overload comes last decides what the person reads.
 */
function compile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'sequence-diagnostics-'))
  try {
    writeFileSync(join(dir, 'fixture.ts'), source)
    writeFileSync(
      join(dir, 'tsconfig.json'),
      JSON.stringify({
        extends: join(ROOT, 'tsconfig.json'),
        compilerOptions: { typeRoots: [join(ROOT, 'node_modules', '@types')] },
        include: [join(dir, 'fixture.ts')],
      }),
    )
    const tsc = spawnSync(join(ROOT, 'node_modules', '.bin', 'tsc'), ['--noEmit', '-p', join(dir, 'tsconfig.json')], {
      encoding: 'utf8',
    })
    return tsc.stdout + tsc.stderr
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('sequence diagnostics', () => {
  it('reports a miswired tuple once, at the step that cannot take its input, naming the joint', () => {
    const output = compile(MISWIRED)
    expect(output.match(/error TS2769/g)).toHaveLength(1)
    expect(output).toContain('fixture.ts(9,41)')
    expect(output).toContain('SequenceJointMismatch<"after children[1]", string, number>')
  })
})
