/**
 * describe(step) and describe.json(step) — composition introspection.
 *
 * `describe(step)` is the text-tree renderer. Multi-line string with
 * hierarchical indentation. Function values render as `<fn>` (or
 * `<fn:name>` when the function has a non-empty `name`); zod schemas
 * render as `<schema>`.
 *
 * `describe.json(step)` returns a `FlowNode` tree (kind, id, config, children)
 * for tooling (Studio UI, Mermaid renderers, diff tools). Function values
 * serialize as `{ kind: '<fn>', name? }` and schemas as `{ kind: '<schema>' }`.
 *
 * Both forms detect cycles. Under the default (loose) mode, back-references
 * render as `<cycle>(id)` in text and `{ kind: '<cycle>', id }` in JSON. Under
 * `{ strict: true }`, cycles throw `describe_cycle_error`.
 */

import { describe_cycle_error } from './errors.js';
import type { Step, StepMetadata } from './types.js';

const INDENT = '  ';

export type FlowValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<FlowValue>
  | Readonly<{ [key: string]: FlowValue }>
  | { readonly kind: '<fn>'; readonly name?: string }
  | { readonly kind: '<schema>' }
  | { readonly kind: string; readonly id: string };

export type FlowNode = {
  readonly kind: string;
  readonly id: string;
  readonly config?: Readonly<{ [key: string]: FlowValue }>;
  readonly children?: ReadonlyArray<FlowNode>;
  readonly meta?: StepMetadata;
};

export type DescribeOptions = {
  readonly strict?: boolean;
};

type Path = Set<Step<unknown, unknown>>;

function describe_text<i, o>(root: Step<i, o>, options?: DescribeOptions): string {
  const lines: string[] = [];
  const strict = Boolean(options?.strict);
  render_text(root, 0, lines, new Set(), strict);
  return lines.join('\n');
}

function describe_json<i, o>(root: Step<i, o>, options?: DescribeOptions): FlowNode {
  const strict = Boolean(options?.strict);
  return render_json(root, new Set(), strict);
}

export const describe: {
  <i, o>(root: Step<i, o>, options?: DescribeOptions): string;
  json: <i, o>(root: Step<i, o>, options?: DescribeOptions) => FlowNode;
} = Object.assign(describe_text, { json: describe_json });

function render_text(
  node: Step<unknown, unknown>,
  depth: number,
  lines: string[],
  path: Path,
  strict: boolean,
): void {
  const prefix = INDENT.repeat(depth);
  if (path.has(node)) {
    if (strict) throw new describe_cycle_error(node.id);
    lines.push(`${prefix}<cycle>(${node.id})`);
    return;
  }
  path.add(node);
  try {
    lines.push(`${prefix}${node.kind}(${node.id})`);
    if (node.config) {
      for (const [key, value] of Object.entries(node.config)) {
        lines.push(`${prefix}${INDENT}${key}: ${render_value_text(value, path, strict)}`);
      }
    }
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        render_text(child, depth + 1, lines, path, strict);
      }
    }
  } finally {
    path.delete(node);
  }
}

function render_value_text(value: unknown, path: Path, strict: boolean): string {
  if (typeof value === 'function') {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : '';
    return name ? `<fn:${name}>` : '<fn>';
  }
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (is_zod_schema(value)) return '<schema>';
  if (is_step(value)) {
    if (path.has(value)) {
      if (strict) throw new describe_cycle_error(value.id);
      return `<cycle>(${value.id})`;
    }
    return `${value.kind}(${value.id})`;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => render_value_text(item, path, strict)).join(', ')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries({ ...value }).map(
      ([k, v]: [string, unknown]) => `${k}: ${render_value_text(v, path, strict)}`,
    );
    return `{ ${entries.join(', ')} }`;
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function render_json(
  node: Step<unknown, unknown>,
  path: Path,
  strict: boolean,
): FlowNode {
  if (path.has(node)) {
    if (strict) throw new describe_cycle_error(node.id);
    return { kind: '<cycle>', id: node.id };
  }
  path.add(node);
  try {
    const result: {
      kind: string;
      id: string;
      config?: { [key: string]: FlowValue };
      children?: FlowNode[];
      meta?: StepMetadata;
    } = { kind: node.kind, id: node.id };
    if (node.config) {
      const config: { [key: string]: FlowValue } = {};
      for (const [key, value] of Object.entries(node.config)) {
        config[key] = render_value_json(value, path, strict);
      }
      result.config = config;
    }
    if (node.children && node.children.length > 0) {
      result.children = node.children.map((child) => render_json(child, path, strict));
    }
    if (node.meta) {
      result.meta = node.meta;
    }
    return result as FlowNode;
  } finally {
    path.delete(node);
  }
}

function render_value_json(value: unknown, path: Path, strict: boolean): FlowValue {
  if (typeof value === 'function') {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : '';
    return name ? { kind: '<fn>', name } : { kind: '<fn>' };
  }
  if (value === null) return null;
  if (value === undefined) return null;
  if (is_zod_schema(value)) return { kind: '<schema>' };
  if (is_step(value)) {
    if (path.has(value)) {
      if (strict) throw new describe_cycle_error(value.id);
      return { kind: '<cycle>', id: value.id };
    }
    return { kind: value.kind, id: value.id };
  }
  if (Array.isArray(value)) {
    return value.map((item: unknown) => render_value_json(item, path, strict));
  }
  if (typeof value === 'object') {
    const out: { [key: string]: FlowValue } = {};
    for (const [k, v] of Object.entries({ ...value })) {
      out[k] = render_value_json(v, path, strict);
    }
    return out;
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return `${value.toString()}n`;
  if (typeof value === 'symbol') return value.toString();
  return JSON.stringify(value);
}

function is_step(value: unknown): value is Step<unknown, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  if (!('id' in value) || !('kind' in value) || !('run' in value)) return false;
  const { id, kind, run } = value;
  return typeof id === 'string' && typeof kind === 'string' && typeof run === 'function';
}

function is_zod_schema(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return '_zod' in value || '_def' in value;
}
