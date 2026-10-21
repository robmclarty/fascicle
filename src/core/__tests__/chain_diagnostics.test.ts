import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The repo root, three levels above this file's folder.
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

// Lesson 4's mistake: a chain opened without saying what it takes.
const UNDECLARED = `import { chain, run } from 'fascicle'

const report = chain('pair')
  .step('sum', ({ pair }) => pair.a + pair.b)
  .output(({ sum }) => \`sum \${sum}\`)

export const answer = run(report, { a: 2, b: 3 })
`

/**
 * Type-check one source file against the library, the way a consumer's
 * compiler sees it, and return the diagnostics that tsc prints.
 *
 * The message is the thing under test, and only a compiler run can show it:
 * what the person reads is the name the compiler prints for the input type.
 */
function compile(source: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'chain-diagnostics-'))
  try {
    writeFileSync(join(dir, 'package.json'), '{ "type": "module" }\n')
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

describe('chain diagnostics', () => {
  it('says to call .input<T>() when a chain never says what it takes', () => {
    const output = compile(UNDECLARED)
    const fix = 'ChainInputUndeclared<"call .input<T>() on the chain to say what it takes">'
    expect(output).toContain(`fixture.ts(4,35): error TS2339: Property 'a' does not exist on type '${fix}'`)
    expect(output).toContain(`fixture.ts(7,37): error TS2353`)
    expect(output.match(/error TS/g)).toHaveLength(3)
    expect(output).not.toContain("type 'never'")
  })
})
