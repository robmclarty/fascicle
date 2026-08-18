/**
 * describe(step) and describe.json(step): composition introspection.
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

import { describe_cycle_error } from './errors.js'
import { is_step } from './is_step.js'
import type { AnyStep, Step, StepMetadata } from './types.js'

const INDENT = '  '

export type FlowValue =
  | string
  | number
  | boolean
  | null
  | ReadonlyArray<FlowValue>
  | Readonly<{ [key: string]: FlowValue }>
  | { readonly kind: '<fn>'; readonly name?: string }
  | { readonly kind: '<schema>' }
  | { readonly kind: string; readonly id: string }

export type FlowNode = {
  readonly kind: string
  readonly id: string
  readonly config?: Readonly<{ [key: string]: FlowValue }>
  readonly children?: ReadonlyArray<FlowNode>
  readonly meta?: StepMetadata
}

export type DescribeOptions = {
  readonly strict?: boolean
}

type Path = Set<AnyStep>

/**
 * Render a step tree as an indented multi-line string.
 */
function describe_text<i, o>(root: Step<i, o>, options?: DescribeOptions): string {
  const lines: string[] = []
  const strict = Boolean(options?.strict)
  render_text(root, 0, lines, new Set(), strict)
  return lines.join('\n')
}

/**
 * Render a step tree as a serializable `FlowNode` tree.
 */
function describe_json<i, o>(root: Step<i, o>, options?: DescribeOptions): FlowNode {
  const strict = Boolean(options?.strict)
  return render_json(root, new Set(), strict)
}

/**
 * Public entry point: `describe(step)` for text, `describe.json(step)` for
 * the `FlowNode` tree.
 */
export const describe: {
  <i, o>(root: Step<i, o>, options?: DescribeOptions): string
  json: <i, o>(root: Step<i, o>, options?: DescribeOptions) => FlowNode
} = Object.assign(describe_text, { json: describe_json })

/**
 * Append one node (label line, config lines, then children) to `lines`.
 *
 * `path` holds the steps on the current root-to-node path for cycle
 * detection; membership is added before recursing and removed in a `finally`
 * so shared (diamond) references are not misreported as cycles.
 */
function render_text(
  node: AnyStep,
  depth: number,
  lines: string[],
  path: Path,
  strict: boolean,
): void {
  const prefix = INDENT.repeat(depth)
  if (path.has(node)) {
    if (strict) throw new describe_cycle_error(node.id)
    lines.push(`${prefix}<cycle>(${node.id})`)
    return
  }
  path.add(node)
  try {
    const display = node.config?.['display_name']
    const label = typeof display === 'string' && display.length > 0 ? display : node.kind
    lines.push(`${prefix}${label}(${node.id})`)
    if (node.config) {
      for (const [key, value] of Object.entries(node.config)) {
        if (key === 'display_name') continue
        lines.push(`${prefix}${INDENT}${key}: ${render_value_text(value, path, strict)}`)
      }
    }
    if (node.children && node.children.length > 0) {
      for (const child of node.children) {
        render_text(child, depth + 1, lines, path, strict)
      }
    }
  } finally {
    path.delete(node)
  }
}

/**
 * Render a single config value for the text tree.
 *
 * Functions become `<fn>` or `<fn:name>`, zod schemas `<schema>`, and Step
 * references `kind(id)`; arrays and plain objects recurse. Strings are
 * JSON-quoted so empty and whitespace values stay visible.
 *
 * Steps, arrays, and renderable objects each own a branch; everything else
 * (functions, the empty markers, schemas, primitives) resolves through
 * `render_scalar_text`. The three object-shaped cases are mutually exclusive at
 * runtime, so their order relative to the scalar cases is immaterial.
 */
function render_value_text(value: unknown, path: Path, strict: boolean): string {
  if (is_step(value)) return render_step_text(value, path, strict)
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => render_value_text(item, path, strict)).join(', ')}]`
  }
  if (is_renderable_object(value)) {
    const entries = Object.entries({ ...value }).map(
      ([k, v]: [string, unknown]) => `${k}: ${render_value_text(v, path, strict)}`,
    )
    return `{ ${entries.join(', ')} }`
  }
  return render_scalar_text(value)
}

/**
 * Render a Step reference for the text tree: a back-reference on the current
 * path becomes `<cycle>(id)` (or throws under strict mode); otherwise `kind(id)`.
 */
function render_step_text(value: AnyStep, path: Path, strict: boolean): string {
  if (path.has(value)) {
    if (strict) throw new describe_cycle_error(value.id)
    return `<cycle>(${value.id})`
  }
  return `${value.kind}(${value.id})`
}

/**
 * Render the non-recursive value cases for the text tree: functions (`<fn>` or
 * `<fn:name>`), the empty markers, zod schemas, and (via `render_primitive_text`)
 * raw primitives.
 */
function render_scalar_text(value: unknown): string {
  if (typeof value === 'function') {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : ''
    return name ? `<fn:${name}>` : '<fn>'
  }
  if (value === null) return 'null'
  if (value === undefined) return 'undefined'
  if (is_zod_schema(value)) return '<schema>'
  return render_primitive_text(value)
}

/**
 * Render a primitive (or unrecognized) value for the text tree. Strings are
 * JSON-quoted so empty and whitespace values stay visible; bigints keep an `n`
 * suffix; anything unexpected falls back to JSON.
 */
function render_primitive_text(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return JSON.stringify(value)
}

/**
 * Convert one step node to a `FlowNode`, recursing into config and children.
 *
 * Uses the same path-based cycle detection as `render_text`: back-references
 * become `{ kind: '<cycle>', id }` in loose mode and throw in strict mode.
 */
function render_json(
  node: AnyStep,
  path: Path,
  strict: boolean,
): FlowNode {
  if (path.has(node)) {
    if (strict) throw new describe_cycle_error(node.id)
    return { kind: '<cycle>', id: node.id }
  }
  path.add(node)
  try {
    const result: {
      kind: string
      id: string
      config?: { [key: string]: FlowValue }
      children?: FlowNode[]
      meta?: StepMetadata
    } = { kind: node.kind, id: node.id }
    if (node.config) {
      const config: { [key: string]: FlowValue } = {}
      for (const [key, value] of Object.entries(node.config)) {
        config[key] = render_value_json(value, path, strict)
      }
      result.config = config
    }
    if (node.children && node.children.length > 0) {
      result.children = node.children.map((child) => render_json(child, path, strict))
    }
    if (node.meta) {
      result.meta = node.meta
    }
    return result
  } finally {
    path.delete(node)
  }
}

/**
 * Convert a single config value to a JSON-safe `FlowValue`.
 *
 * Functions serialize as `{ kind: '<fn>', name? }`, schemas as
 * `{ kind: '<schema>' }`, Step references as `{ kind, id }`. `undefined`
 * maps to `null` and bigints/symbols to strings so the result survives
 * `JSON.stringify` without loss.
 *
 * Mirrors `render_value_text`: steps, arrays, and renderable objects each own a
 * branch, and everything else resolves through `render_scalar_json`.
 */
function render_value_json(value: unknown, path: Path, strict: boolean): FlowValue {
  if (is_step(value)) return render_step_json(value, path, strict)
  if (Array.isArray(value)) {
    return value.map((item: unknown) => render_value_json(item, path, strict))
  }
  if (is_renderable_object(value)) {
    const out: { [key: string]: FlowValue } = {}
    for (const [k, v] of Object.entries({ ...value })) {
      out[k] = render_value_json(v, path, strict)
    }
    return out
  }
  return render_scalar_json(value)
}

/**
 * Serialize a Step reference: a back-reference on the current path becomes
 * `{ kind: '<cycle>', id }` (or throws under strict mode); otherwise `{ kind, id }`.
 */
function render_step_json(value: AnyStep, path: Path, strict: boolean): FlowValue {
  if (path.has(value)) {
    if (strict) throw new describe_cycle_error(value.id)
    return { kind: '<cycle>', id: value.id }
  }
  return { kind: value.kind, id: value.id }
}

/**
 * Serialize the non-recursive value cases: functions, the empty markers, zod
 * schemas, and (via `render_primitive_json`) raw primitives.
 */
function render_scalar_json(value: unknown): FlowValue {
  if (typeof value === 'function') {
    const name = typeof value.name === 'string' && value.name.length > 0 ? value.name : ''
    return name ? { kind: '<fn>', name } : { kind: '<fn>' }
  }
  if (value === null) return null
  if (value === undefined) return null
  if (is_zod_schema(value)) return { kind: '<schema>' }
  return render_primitive_json(value)
}

/**
 * Serialize a primitive (or unrecognized) value. `undefined` already resolves
 * to `null` in `render_scalar_json`; bigints and symbols become strings so the
 * result survives `JSON.stringify` without loss.
 */
function render_primitive_json(value: unknown): FlowValue {
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return value
  if (typeof value === 'bigint') return `${value.toString()}n`
  if (typeof value === 'symbol') return value.toString()
  return JSON.stringify(value)
}

/**
 * Detect a zod schema by its internal marker properties (`_zod` in zod 4,
 * `_def` in zod 3) without importing zod.
 */
function is_zod_schema(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false
  return '_zod' in value || '_def' in value
}

/**
 * True for a plain object rendered by recursing into its own entries: an object
 * that is neither null nor a zod schema. The Step and array cases are checked
 * before this at every call site, so they never reach it.
 */
function is_renderable_object(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !is_zod_schema(value)
}
