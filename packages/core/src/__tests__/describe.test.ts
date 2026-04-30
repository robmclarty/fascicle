import { z } from 'zod';
import { describe as vdescribe, expect, it } from 'vitest';
import { describe, type FlowNode } from '../describe.js';
import { describe_cycle_error } from '../errors.js';
import { parallel } from '../parallel.js';
import { sequence } from '../sequence.js';
import { step } from '../step.js';

function accept_non_empty(r: unknown): boolean {
  return Boolean(r);
}

function validate_response(r: unknown): boolean {
  return Boolean(r);
}

vdescribe('describe (text)', () => {
  it('renders a single step with its id and <fn> placeholder', () => {
    const s = step('my_step', (x: number) => x + 1);
    const out = describe(s);
    expect(out).toContain('my_step');
    expect(out).toContain('step');
  });

  it('echoes step meta on describe.json output when present', () => {
    const labelled = step('inc', (x: number) => x + 1, {
      display_name: 'Increment',
      description: 'Adds one',
      port_labels: { in: 'count', out: 'count + 1' },
    });
    const tree = describe.json(labelled);
    expect(tree.meta).toEqual({
      display_name: 'Increment',
      description: 'Adds one',
      port_labels: { in: 'count', out: 'count + 1' },
    });
  });

  it('omits meta on describe.json output when the step has none', () => {
    const plain = step('p', (x: number) => x);
    const tree = describe.json(plain);
    expect(tree.meta).toBeUndefined();
  });

  it('renders function config values as <fn:name> when a name is available', () => {
    const synthetic = {
      id: 'synthetic',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        accept: accept_non_empty,
        max_rounds: 3,
      },
    };
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0]);
    expect(out).toContain('<fn:accept_non_empty>');
    expect(out).toContain('3');
  });

  it('renders truly anonymous function config values as <fn>', () => {
    const anon = (() => (r: unknown) => Boolean(r))();
    Object.defineProperty(anon, 'name', { value: '' });
    const synthetic = {
      id: 'synthetic_anon',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        accept: anon,
      },
    };
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0]);
    expect(out).toMatch(/<fn>/);
  });

  it('indents children one level deeper than the parent', () => {
    const child = step('leaf', (x: number) => x);
    const parent = {
      id: 'root',
      kind: 'synthetic',
      run: async (x: number) => x,
      children: [child],
    };
    const out = describe(parent as unknown as Parameters<typeof describe>[0]);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^synthetic\(root\)$/);
    expect(lines[1]).toMatch(/^ {2}step\(leaf\)$/);
  });

  it('renders the assorted primitive and container value shapes', () => {
    const inner = step('inner', (x: number) => x);
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
    };
    const out = describe(synthetic as unknown as Parameters<typeof describe>[0]);
    expect(out).toContain('null');
    expect(out).toContain('undefined');
    expect(out).toContain('"hi"');
    expect(out).toContain('7');
    expect(out).toContain('true');
    expect(out).toContain('9n');
    expect(out).toContain('Symbol(s)');
    expect(out).toContain('[1, "two", null]');
    expect(out).toContain('step(inner)');
  });
});

vdescribe('describe.json', () => {
  it('is exposed as a namespace member on describe', () => {
    expect(typeof describe.json).toBe('function');
  });

  it('returns a FlowNode tree for a leaf step', () => {
    const s = step('leaf', (x: number) => x + 1);
    const tree = describe.json(s);
    expect(tree.kind).toBe('step');
    expect(tree.id).toBe('leaf');
    expect(tree.children).toBeUndefined();
  });

  it('returns a tree with nested children for a sequence+parallel composition', () => {
    const a = step('a', (x: number) => x);
    const b = step('b', (x: number) => x);
    const c = step('c', (x: number) => x);
    const flow = sequence([a, parallel({ b, c })]);
    const tree = describe.json(flow);
    expect(tree.kind).toBe('sequence');
    expect(tree.children).toBeDefined();
    expect(tree.children?.length).toBe(2);
    const first = tree.children?.[0];
    expect(first?.kind).toBe('step');
    expect(first?.id).toBe('a');
    const second = tree.children?.[1];
    expect(second?.kind).toBe('parallel');
    expect(second?.children?.length).toBe(2);
    const ids = new Set(second?.children?.map((c_: { id: string }) => c_.id) ?? []);
    expect(ids.has('b')).toBe(true);
    expect(ids.has('c')).toBe(true);
  });

  it('serializes anonymous function config values as { kind: "<fn>" }', () => {
    const synthetic = {
      id: 'with_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        predicate: (r: unknown) => Boolean(r),
      },
    };
    const tree = describe.json(synthetic as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.config?.['predicate']).toEqual({ kind: '<fn>', name: 'predicate' });
  });

  it('captures the function name on named function expressions and declarations', () => {
    const synthetic = {
      id: 'with_named_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        check: validate_response,
      },
    };
    const tree = describe.json(synthetic as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.config?.['check']).toEqual({ kind: '<fn>', name: 'validate_response' });
  });

  it('omits the name when the function is truly anonymous', () => {
    const anon = (() => (r: unknown) => Boolean(r))();
    Object.defineProperty(anon, 'name', { value: '' });
    const synthetic = {
      id: 'with_anon_fn',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        check: anon,
      },
    };
    const tree = describe.json(synthetic as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.config?.['check']).toEqual({ kind: '<fn>' });
  });

  it('serializes zod schema config values as { kind: "<schema>" }', () => {
    const schema = z.object({ name: z.string() });
    const synthetic = {
      id: 'with_schema',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        shape: schema,
      },
    };
    const tree = describe.json(synthetic as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.config?.['shape']).toEqual({ kind: '<schema>' });
  });

  it('renders a cyclic children edge as { kind: "<cycle>", id } in loose mode', () => {
    const leaf = step('leaf', (x: number) => x);
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'root',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [leaf],
    };
    root.children.push(root);
    const tree = describe.json(root as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.id).toBe('root');
    expect(tree.children?.length).toBe(2);
    expect(tree.children?.[1]).toEqual({ kind: '<cycle>', id: 'root' });
  });

  it('throws describe_cycle_error in strict mode for a cyclic flow', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'loop',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [],
    };
    root.children.push(root);
    expect(() =>
      describe.json(root as unknown as Parameters<typeof describe.json>[0], { strict: true }),
    ).toThrow(describe_cycle_error);
  });

  it('text describe also throws describe_cycle_error in strict mode', () => {
    const root: { id: string; kind: string; run: (x: number) => number; children: unknown[] } = {
      id: 'loop',
      kind: 'synthetic',
      run: (x: number) => x,
      children: [],
    };
    root.children.push(root);
    expect(() =>
      describe(root as unknown as Parameters<typeof describe>[0], { strict: true }),
    ).toThrow(describe_cycle_error);
  });

  it('return value is assignable to FlowNode (type-level)', () => {
    const s = step('typed', (x: number) => x);
    const tree: FlowNode = describe.json(s);
    expect(tree.kind).toBe('step');
  });

  it('renders nested step values in config as { kind, id } references', () => {
    const nested = step('nested', (x: number) => x);
    const synthetic = {
      id: 'with_ref',
      kind: 'synthetic',
      run: (x: number) => x,
      config: {
        child: nested,
      },
    };
    const tree = describe.json(synthetic as unknown as Parameters<typeof describe.json>[0]);
    expect(tree.config?.['child']).toEqual({ kind: 'step', id: 'nested' });
  });
});
