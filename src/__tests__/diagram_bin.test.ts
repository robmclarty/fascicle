import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// The bin runs in a child process, the way the package's shim runs it. The
// fixture app is an ESM package in a temp directory whose steps are
// hand-built objects, so it resolves nothing outside itself. tsx comes from
// this repo, which is the child's working directory.
const here = dirname(fileURLToPath(import.meta.url))
const repo_root = join(here, '..', '..')
const bin_script = join(repo_root, 'src', 'diagram_bin.ts')
const register_script = join(repo_root, 'test', 'support', 'register-ts-resolver.mjs')

const PARTS_TS = `
type Leaf = { id: string; kind: string; run: (x: unknown) => unknown; meta?: { description: string } }

export function leaf(id: string, description: string): Leaf {
  return { id, kind: 'step', run: (x) => x, meta: { description } }
}
`

const FLOW_TS = `
import { leaf } from './parts.js'

export const flow = {
  id: 'sequence_9',
  kind: 'sequence',
  run: (x: unknown): unknown => x,
  config: { display_name: 'writer' },
  children: [leaf('draft', 'write a first pass'), leaf('polish', 'tidy the draft')],
}
`

const PLAIN_MJS = `
export const flow = { id: 'plain', kind: 'step', run: (x) => x }
`

const WRITER = ['writer     sequence', '├─ draft   write a first pass', '└─ polish  tidy the draft', ''].join('\n')

type ChildResult = { readonly code: number | null; readonly stdout: string; readonly stderr: string }

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fascicle-diagram-bin-'))
  await writeFile(join(dir, 'package.json'), '{ "type": "module" }\n')
  await writeFile(join(dir, 'parts.ts'), PARTS_TS)
  await writeFile(join(dir, 'flow.ts'), FLOW_TS)
  await writeFile(join(dir, 'plain.mjs'), PLAIN_MJS)
})

afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

function spawn_bin(args: readonly string[], options: { readonly close_stdout?: boolean } = {}): Promise<ChildResult> {
  const child = spawn(process.execPath, ['--import', register_script, bin_script, ...args], {
    cwd: repo_root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (options.close_stdout === true) child.stdout.destroy()
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString()
  })
  return new Promise((resolve) => {
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

describe('fascicle-diagram bin (spawned)', () => {
  it('loads a TypeScript module through tsx, following its .js specifiers, and exits 0', async () => {
    const result = await spawn_bin([join(dir, 'flow.ts')])
    expect(result).toEqual({ code: 0, stdout: WRITER, stderr: '' })
  })

  it('loads a JavaScript module with a plain import', async () => {
    const result = await spawn_bin([join(dir, 'plain.mjs')])
    expect(result).toEqual({ code: 0, stdout: 'plain  step\n', stderr: '' })
  })

  it('exits 1 when the module does not exist', async () => {
    const result = await spawn_bin([join(dir, 'missing.ts')])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('fascicle-diagram: could not load')
  })

  it('exits 2 on a usage error', async () => {
    const result = await spawn_bin([])
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('fascicle-diagram: a <module> to draw is required')
  })

  it('ends quietly when the reader closes the pipe before the diagram is written', async () => {
    const result = await spawn_bin([join(dir, 'flow.ts')], { close_stdout: true })
    expect(result.code).toBe(0)
    expect(result.stderr).toBe('')
  })
})
