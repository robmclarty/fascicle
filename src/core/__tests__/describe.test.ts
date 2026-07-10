import { z } from 'zod'
import { describe as vdescribe, expect, it } from 'vitest'
import { describe, type FlowNode, type FlowValue } from '../describe.js'
import { describe_cycle_error } from '../errors.js'
import { parallel } from '../parallel.js'
import { sequence } from '../sequence.js'
import { step } from '../step.js'

function accept_non_empty(r: unknown): boolean {
  return Boolean(r)
}

function validate_response(r: unknown): boolean {
  return Boolean(r)
}

vdescribe('describe (text)', () => {
  it('renders a single step with its id and <fn> placeholder', () => {
    const s = step('my_step', (x: number) => x + 1)
    const out = describe(s)
    expect(out).toContain('my_step')
    expect(out).toContain('step')
  })

  it('echoes step meta on describe.json output when present', () => {
    const labelled = step('inc', (x: number) => x + 1, {
      display_name: 'Increment',
      description: 'Adds one',
      port_labels: { in: 'count', out: 'count + 1' },
    })
    const tree = describe.json(labelled)
    expect(tree.meta).toEqual({
      display_name: 'Increment',
      description: 'Adds one',
      port_labels: { in: 'count', out: 'count + 1' },
    })
  })

  it('omits meta on describe.json output when the step has none', () => {
    const plain = step('p', (x: number) => x)
    const tree = describe.json(plain)
    expect(tree.meta).toBeUndefined()
  })

  it('renders function config values as <fn:name> when a name is available', () => {
    const synthetic = {
      id: 'synthetic',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        accept: accept_non_empty,
        max_rounds: 3,
      },
    }
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0])
    expect(out).toContain('<fn:accept_non_empty>')
    expect(out).toContain('3')
  })

  it('renders truly anonymous function config values as <fn>', () => {
    const anon = (() => (r: unknown) => Boolean(r))()
    Object.defineProperty(anon, 'name', { value: '' })
    const synthetic = {
      id: 'synthetic_anon',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        accept: anon,
      },
    }
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0])
    expect(out).toMatch(/<fn>/)
  })

  it('indents children one level deeper than the parent', () => {
    const child = step('leaf', (x: number) => x)
    const parent = {
      id: 'root',
      kind: 'synthetic',
      run: async (x: number) => x,
      children: [child],
    }
    const out = describe(parent as unknown as Parameters<typeof describe>[0])
    const lines = out.split('\n')
    expect(lines[0]).toMatch(/^synthetic\(root\)$/)
    expect(lines[1]).toMatch(/^ {2}step\(leaf\)$/)
  })

  it('renders the assorted primitive and container value shapes', () => {
    const inner = step('inner', (x: number) => x)
    const synthetic = {
      id: 'shapes',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        null_v: null,
        undef_v: undefined,
        str: 'hi',
        num: 7,
        bool: true,
        big: 9n,
        sym: Symbol('s'),
        arr: [1, 'two', null],
        obj: { a: 1, b: 'c' },
        nested_step: inner,
      },
    }
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0])
    expect(out).toContain('null')
    expect(out).toContain('undefined')
    expect(out).toContain('"hi"')
    expect(out).toContain('7')
    expect(out).toContain('true')
    expect(out).toContain('9n')
    expect(out).toContain('Symbol(s)')
    expect(out).toContain('[1, "two", null]')
    expect(out).toContain('step(inner)')
  })
})

vdescribe('describe.json', () => {
  it('is exposed as a namespace member on describe', () => {
    expect(typeof describe.json).toBe('function')
  })

  it('returns a FlowNode tree for a leaf step', () => {
    const s = step('leaf', (x: number) => x + 1)
    const tree = describe.json(s)
    expect(tree.kind).toBe('step')
    expect(tree.id).toBe('leaf')
    expect(tree.children).toBeUndefined()
  })

  it('returns a tree with nested children for a sequence+parallel composition', () => {
    const a = step('a', (x: number) => x)
    const b = step('b', (x: number) => x)
    const c = step('c', (x: number) => x)
    const flow = sequence([a, parallel({ b, c })])
    const tree = describe.json(flow)
    expect(tree.kind).toBe('sequence')
    expect(tree.children).toBeDefined()
    expect(tree.children?.length).toBe(2)
    const first = tree.children?.[0]
    expect(first?.kind).toBe('step')
    expect(first?.id).toBe('a')
    const second = tree.children?.[1]
    expect(second?.kind).toBe('parallel')
    expect(second?.children?.length).toBe(2)
    const ids = new Set(second?.children?.map((c_: { id: string }) => c_.id) ?? [])
    expect(ids.has('b')).toBe(true)
    expect(ids.has('c')).toBe(true)
  })

  it('serializes anonymous function config values as { kind: "<fn>" }', () => {
    const synthetic = {
      id: 'with_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        predicate: (r: unknown) => Boolean(r),
      },
    }
    const tree = describe.json(synthetic)
    expect(tree.config?.['predicate']).toEqual({ kind: '<fn>', name: 'predicate' })
  })

  it('captures the function name on named function expressions and declarations', () => {
    const synthetic = {
      id: 'with_named_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        check: validate_response,
      },
    }
    const tree = describe.json(synthetic)
    expect(tree.config?.['check']).toEqual({ kind: '<fn>', name: 'validate_response' })
  })

  it('omits the name when the function is truly anonymous', () => {
    const anon = (() => (r: unknown) => Boolean(r))()
    Object.defineProperty(anon, 'name', { value: '' })
    const synthetic = {
      id: 'with_anon_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        check: anon,
      },
    }
    const tree = describe.json(synthetic)
    expect(tree.config?.['check']).toEqual({ kind: '<fn>' })
  })

  it('serializes zod schema config values as { kind: "<schema>" }', () => {
    const schema = z.object({ name: z.string() })
    const synthetic = {
      id: 'with_schema',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        shape: schema,
      },
    }
    const tree = describe.json(synthetic)
    expect(tree.config?.['shape']).toEqual({ kind: '<schema>' })
  })

  it('renders a cyclic children edge as { kind: "<cycle>", id } in loose mode', () => {
    const leaf = step('leaf', (x: number) => x)
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'root',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [leaf],
    }
    root.children.push(root)
    const tree = describe.json(root as unknown as Parameters<typeof describe.json>[0])
    expect(tree.id).toBe('root')
    expect(tree.children?.length).toBe(2)
    expect(tree.children?.[1]).toEqual({ kind: '<cycle>', id: 'root' })
  })

  it('throws describe_cycle_error in strict mode for a cyclic flow', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'loop',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [],
    }
    root.children.push(root)
    expect(() =>
      describe.json(root as unknown as Parameters<typeof describe.json>[0], { strict: true }),
    ).toThrow(describe_cycle_error)
  })

  it('text describe also throws describe_cycle_error in strict mode', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'loop',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [],
    }
    root.children.push(root)
    expect(() =>
      describe(root as unknown as Parameters<typeof describe>[0], { strict: true }),
    ).toThrow(describe_cycle_error)
  })

  it('return value is assignable to FlowNode (type-level)', () => {
    const s = step('typed', (x: number) => x)
    const tree: FlowNode = describe.json(s)
    expect(tree.kind).toBe('step')
  })

  it('renders nested step values in config as { kind, id } references', () => {
    const nested = step('nested', (x: number) => x)
    const synthetic = {
      id: 'with_ref',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        child: nested,
      },
    }
    const tree = describe.json(synthetic)
    expect(tree.config?.['child']).toEqual({ kind: 'step', id: 'nested' })
  })
})

type AnyStep = Parameters<typeof describe>[0]

function as_step(node: object): AnyStep {
  return node as unknown as AnyStep
}

// Renders a node with a single config key `x` and returns the exact config line
// from the text output (`  x: <rendered>`), pinning the rendered value format.
function text_value(value: unknown): string {
  const node = { id: 'v', kind: 'k', run: (input: unknown) => input, config: { x: value } }
  const line = describe(as_step(node)).split('\n')[1]
  if (line === undefined) throw new Error('expected a config line')
  return line
}

function json_value(value: unknown): FlowValue | undefined {
  const node = { id: 'v', kind: 'k', run: (input: unknown) => input, config: { x: value } }
  return describe.json(as_step(node)).config?.['x']
}

vdescribe('describe value rendering (text, exact format)', () => {
  it('renders named functions as <fn:name>', () => {
    expect(text_value(validate_response)).toBe('  x: <fn:validate_response>')
  })

  it('renders anonymous functions as <fn>', () => {
    const anon = (() => (r: unknown) => Boolean(r))()
    Object.defineProperty(anon, 'name', { value: '' })
    expect(text_value(anon)).toBe('  x: <fn>')
  })

  it('renders null and undefined with their keywords', () => {
    expect(text_value(null)).toBe('  x: null')
    expect(text_value(undefined)).toBe('  x: undefined')
  })

  it('renders zod schemas as <schema>', () => {
    expect(text_value(z.object({ a: z.string() }))).toBe('  x: <schema>')
  })

  it('renders strings with surrounding quotes', () => {
    expect(text_value('hi')).toBe('  x: "hi"')
  })

  it('renders numbers and both booleans verbatim', () => {
    expect(text_value(7)).toBe('  x: 7')
    expect(text_value(0)).toBe('  x: 0')
    expect(text_value(true)).toBe('  x: true')
    expect(text_value(false)).toBe('  x: false')
  })

  it('renders bigints with an n suffix', () => {
    expect(text_value(9n)).toBe('  x: 9n')
  })

  it('renders symbols via their string form', () => {
    expect(text_value(Symbol('s'))).toBe('  x: Symbol(s)')
  })

  it('renders arrays with bracketed, comma-joined members', () => {
    expect(text_value([1, 'two', null])).toBe('  x: [1, "two", null]')
  })

  it('renders plain objects with brace-wrapped key: value pairs', () => {
    expect(text_value({ a: 1, b: 'c' })).toBe('  x: { a: 1, b: "c" }')
  })

  it('renders step values in config as kind(id)', () => {
    expect(text_value(step('inner', (x: number) => x))).toBe('  x: step(inner)')
  })
})

vdescribe('describe value rendering (json, exact format)', () => {
  it('serializes null and undefined both to null', () => {
    expect(json_value(null)).toBeNull()
    expect(json_value(undefined)).toBeNull()
  })

  it('serializes strings, numbers, and booleans as themselves', () => {
    expect(json_value('hi')).toBe('hi')
    expect(json_value(7)).toBe(7)
    expect(json_value(true)).toBe(true)
    expect(json_value(false)).toBe(false)
  })

  it('serializes bigints and symbols to their string forms', () => {
    expect(json_value(9n)).toBe('9n')
    expect(json_value(Symbol('s'))).toBe('Symbol(s)')
  })

  it('serializes arrays by mapping each member', () => {
    expect(json_value([1, 'two', null])).toEqual([1, 'two', null])
  })

  it('serializes plain objects key by key', () => {
    expect(json_value({ a: 1, b: 'c' })).toEqual({ a: 1, b: 'c' })
  })

  it('serializes zod schemas as { kind: "<schema>" }', () => {
    expect(json_value(z.object({ a: z.string() }))).toEqual({ kind: '<schema>' })
  })
})

vdescribe('describe is_step discrimination', () => {
  const marker = 'KEEP'

  it('treats a fully-formed step value as a kind(id) reference', () => {
    const valid = { id: 's1', kind: 'mystep', run: (x: unknown) => x, marker }
    expect(json_value(valid)).toEqual({ kind: 'mystep', id: 's1' })
    expect(text_value(valid)).toBe('  x: mystep(s1)')
  })

  it('rejects objects whose id is not a string', () => {
    const v = { id: 9, kind: 'k', run: (x: unknown) => x, marker }
    expect(json_value(v)).toMatchObject({ marker })
  })

  it('rejects objects whose kind is not a string', () => {
    const v = { id: 's', kind: 7, run: (x: unknown) => x, marker }
    expect(json_value(v)).toMatchObject({ marker })
  })

  it('rejects objects whose run is not a function', () => {
    const v = { id: 's', kind: 'k', run: 5, marker }
    expect(json_value(v)).toMatchObject({ marker })
  })

  it('rejects objects missing the id, kind, or run key', () => {
    expect(json_value({ kind: 'k', run: (x: unknown) => x, marker })).toMatchObject({ marker })
    expect(json_value({ id: 's', run: (x: unknown) => x, marker })).toMatchObject({ marker })
    expect(json_value({ id: 's', kind: 'k', marker })).toMatchObject({ marker })
  })
})

vdescribe('describe is_zod_schema discrimination', () => {
  it('treats an object carrying only _zod as a schema', () => {
    expect(json_value({ _zod: {} })).toEqual({ kind: '<schema>' })
  })

  it('treats an object carrying only _def as a schema', () => {
    expect(json_value({ _def: {} })).toEqual({ kind: '<schema>' })
  })

  it('treats an object carrying neither marker as a plain object', () => {
    expect(json_value({ shape: 1 })).toEqual({ shape: 1 })
  })
})

vdescribe('describe display_name labelling (text)', () => {
  it('uses a non-empty display_name as the node label', () => {
    const node = { id: 'n', kind: 'k', run: (x: unknown) => x, config: { display_name: 'Pretty' } }
    const lines = describe(as_step(node)).split('\n')
    expect(lines[0]).toBe('Pretty(n)')
  })

  it('does not echo display_name as a config line', () => {
    const node = {
      id: 'n',
      kind: 'k',
      run: (x: unknown) => x,
      config: { display_name: 'Pretty', other: 1 },
    }
    const out = describe(as_step(node))
    expect(out).not.toContain('display_name')
    expect(out).toContain('  other: 1')
  })

  it('falls back to the kind when display_name is an empty string', () => {
    const node = { id: 'n', kind: 'k', run: (x: unknown) => x, config: { display_name: '' } }
    expect(describe(as_step(node)).split('\n')[0]).toBe('k(n)')
  })

  it('falls back to the kind when display_name is absent', () => {
    const node = { id: 'n', kind: 'k', run: (x: unknown) => x, config: { other: 1 } }
    expect(describe(as_step(node)).split('\n')[0]).toBe('k(n)')
  })
})

vdescribe('describe cycle handling', () => {
  it('renders a cyclic child edge as <cycle>(id) in loose-mode text', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      children: [],
    }
    root.children.push(root)
    const lines = describe(as_step(root)).split('\n')
    expect(lines[0]).toBe('k(root)')
    expect(lines[1]).toBe('  <cycle>(root)')
  })

  it('renders a cyclic config edge as <cycle>(id) in loose-mode text', () => {
    const root: { id: string; kind: string; run: (x: number) => number; config: unknown } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      config: {},
    }
    root.config = { self: root }
    expect(describe(as_step(root)).split('\n')[1]).toBe('  self: <cycle>(root)')
  })

  it('serializes a cyclic config edge as { kind: "<cycle>", id } in loose-mode json', () => {
    const root: { id: string; kind: string; run: (x: number) => number; config: unknown } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      config: {},
    }
    root.config = { self: root }
    expect(describe.json(as_step(root)).config?.['self']).toEqual({ kind: '<cycle>', id: 'root' })
  })

  it('throws on a cyclic config edge in strict-mode text', () => {
    const root: { id: string; kind: string; run: (x: number) => number; config: unknown } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      config: {},
    }
    root.config = { self: root }
    expect(() => describe(as_step(root), { strict: true })).toThrow(describe_cycle_error)
  })

  it('throws on a cyclic config edge in strict-mode json', () => {
    const root: { id: string; kind: string; run: (x: number) => number; config: unknown } = {
      id: 'root',
      kind: 'k',
      run: (x: number) => x,
      config: {},
    }
    root.config = { self: root }
    expect(() => describe.json(as_step(root), { strict: true })).toThrow(describe_cycle_error)
  })
})

vdescribe('describe children presence', () => {
  it('emits no child lines and omits json children for an empty children array', () => {
    const node = { id: 'e', kind: 'k', run: (x: unknown) => x, children: [] }
    expect(describe(as_step(node))).toBe('k(e)')
    expect(describe.json(as_step(node)).children).toBeUndefined()
  })

  it('renders a node shared across two sibling slots both times, not as a cycle', () => {
    const shared = step('shared', (x: number) => x)
    const root = { id: 'root', kind: 'k', run: (x: number) => x, children: [shared, shared] }
    const lines = describe(as_step(root)).split('\n')
    expect(lines[1]).toBe('  step(shared)')
    expect(lines[2]).toBe('  step(shared)')
    const tree = describe.json(as_step(root))
    expect(tree.children).toEqual([
      { kind: 'step', id: 'shared' },
      { kind: 'step', id: 'shared' },
    ])
  })
})

vdescribe('describe non-finite numbers', () => {
  it('renders NaN via String, not the JSON.stringify fallback', () => {
    expect(text_value(Number.NaN)).toBe('  x: NaN')
    expect(text_value(Number.POSITIVE_INFINITY)).toBe('  x: Infinity')
  })

  it('serializes NaN as a number, not the stringified fallback', () => {
    expect(json_value(Number.NaN)).toBeNaN()
    expect(json_value(Number.POSITIVE_INFINITY)).toBe(Number.POSITIVE_INFINITY)
  })
})
