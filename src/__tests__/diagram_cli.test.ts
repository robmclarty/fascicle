import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sequence, step } from '#core'
import { run_diagram_cli } from '../diagram_cli.js'

const writer = sequence(
  [
    step('draft', (topic: string) => `notes on ${topic}`, { description: 'write a first pass' }),
    step('polish', (text: string) => text.trim(), { description: 'tidy the draft' }),
  ],
  { name: 'writer' },
)

const WRITER = ['writer     sequence', '├─ draft   write a first pass', '└─ polish  tidy the draft'].join('\n')

const MODULE: Readonly<Record<string, unknown>> = {
  flow: writer,
  build_it: () => step('built', (x: number) => x, { description: 'made by a builder' }),
  build_later: async () => step('later', (x: number) => x, { description: 'made by an async builder' }),
  needs_deps: (deps: { readonly engine: string }) => step(deps.engine, (x: number) => x),
  not_a_step: { id: 'x' },
}

type Result = {
  readonly code: number
  readonly out: string
  readonly err: string
  readonly loaded: ReadonlyArray<string>
}

async function cli(
  argv: readonly string[],
  load: (path: string) => Promise<Readonly<Record<string, unknown>>> = async () => MODULE,
): Promise<Result> {
  let out = ''
  let err = ''
  const loaded: string[] = []
  const code = await run_diagram_cli(argv, {
    out: (text) => {
      out += text
    },
    err: (text) => {
      err += text
    },
    load: (path) => {
      loaded.push(path)
      return load(path)
    },
  })
  return { code, out, err, loaded }
}

describe('run_diagram_cli', () => {
  it("prints the diagram of the module's flow export and exits 0", async () => {
    const result = await cli(['/app/src/diagram.ts'])
    expect(result).toEqual({ code: 0, out: `${WRITER}\n`, err: '', loaded: ['/app/src/diagram.ts'] })
  })

  it('loads a relative module path from the working directory', async () => {
    const result = await cli(['src/diagram.ts'])
    expect(result.loaded).toEqual([resolve('src/diagram.ts')])
  })

  it('draws another export, calling a builder with no arguments and awaiting an async one', async () => {
    expect((await cli(['m.ts', '--export', 'build_it'])).out).toBe('built  made by a builder\n')
    expect((await cli(['m.ts', '--export', 'build_later'])).out).toBe('later  made by an async builder\n')
  })

  it('passes --width and --prefix through to the diagram', async () => {
    const result = await cli(['m.ts', '--width', '24', '--prefix', ' * '])
    expect(result.out).toBe(
      [
        ' * writer     sequence',
        ' * ├─ draft   write a',
        ' * │          first pass',
        ' * └─ polish  tidy the',
        ' *            draft',
        '',
      ].join('\n'),
    )
  })

  it('names the exports it found when the requested one is missing', async () => {
    const result = await cli(['m.ts', '--export', 'nope'], async () => ({ flow: writer, other: 1 }))
    expect(result.code).toBe(1)
    expect(result.out).toBe('')
    expect(result.err).toBe(
      'fascicle-diagram: m.ts has no export named nope: pass --export <name> (it exports flow, other)\n',
    )
  })

  it('says so when the module exports nothing at all', async () => {
    const result = await cli(['m.ts'], async () => ({}))
    expect(result.err).toBe(
      'fascicle-diagram: m.ts has no export named flow: pass --export <name> (it exports nothing)\n',
    )
  })

  it('refuses an export that is not a Step', async () => {
    const result = await cli(['m.ts', '--export', 'not_a_step'])
    expect(result.code).toBe(1)
    expect(result.err).toBe(
      'fascicle-diagram: not_a_step in m.ts is not a Step: export the flow itself, or a function that builds it with no arguments\n',
    )
  })

  it('explains a builder that throws because it wants dependencies', async () => {
    const result = await cli(['m.ts', '--export', 'needs_deps'])
    expect(result.code).toBe(1)
    expect(result.err).toMatch(/^fascicle-diagram: calling needs_deps\(\) in m\.ts threw: .*engine/)
    expect(result.err).toContain(
      '\nExport a function that builds the flow with no arguments, wired to stub dependencies.\n',
    )
  })

  it('reports a module it cannot load, with the thrown value when it is not an Error', async () => {
    const failed = await cli(['m.ts'], async () => {
      throw new Error('Cannot find module')
    })
    const odd = await cli(['m.ts'], async () => {
      throw 'plain string'
    })
    expect(failed.code).toBe(1)
    expect(failed.err).toBe('fascicle-diagram: could not load m.ts: Cannot find module\n')
    expect(odd.err).toContain('could not load m.ts: plain string\n')
  })

  it('prints usage for --help and exits 0 without loading anything', async () => {
    const result = await cli(['--help', 'm.ts'])
    expect(result.code).toBe(0)
    expect(result.err).toBe('')
    expect(result.loaded).toEqual([])
    expect(result.out).toContain('fascicle-diagram <module> --export <name>')
  })

  it.each([
    [[], 'a <module> to draw is required'],
    [['a.ts', 'b.ts'], 'expected one <module>, got a.ts b.ts'],
    [['a.ts', '--width', '0'], "invalid --width '0': expected a positive integer"],
    [['a.ts', '--width=-3'], "invalid --width '-3': expected a positive integer"],
    [['a.ts', '--width', '2.5'], "invalid --width '2.5': expected a positive integer"],
    [['a.ts', '--width', 'wide'], "invalid --width 'wide': expected a positive integer"],
    [['a.ts', '--depth', '3'], "Unknown option '--depth'"],
  ])('exits 2 with usage for %j', async (argv, message) => {
    const result = await cli(argv)
    expect(result.code).toBe(2)
    expect(result.out).toBe('')
    expect(result.loaded).toEqual([])
    expect(result.err.startsWith(`fascicle-diagram: ${message}`)).toBe(true)
    expect(result.err).toContain('\n\nfascicle-diagram prints a flow')
  })

  it('accepts a width of 1, the smallest positive integer', async () => {
    const result = await cli(['m.ts', '--width', '1'])
    expect(result.code).toBe(0)
  })
})
