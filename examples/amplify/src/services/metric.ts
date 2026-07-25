/**
 * Metric loader: resolves a string identifier (`speed` | `golden` | `quality`
 * or a path to a custom .ts module) to a `Metric`. Custom paths are loaded
 * via dynamic import; the module must export a function
 * `make_metric(target_dir: string): Metric`.
 *
 * Validation is intentionally light. We check the required fields exist;
 * the rest is the metric author's responsibility.
 */

import { isAbsolute, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import type { Metric } from '../types.js'

const BUILTINS = new Set(['speed', 'golden', 'quality'])

type MetricFactory = (target_dir: string) => Metric

function is_record(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function get_factory(mod: unknown, source: string): MetricFactory {
  if (!is_record(mod)) {
    throw new Error(`metric module ${source}: not an object`)
  }
  const factory = mod['make_metric']
  if (typeof factory !== 'function') {
    throw new Error(`metric module ${source}: missing exported function "make_metric"`)
  }
  // The module's runtime shape is what we just verified; TypeScript can't
  // see through the dynamic import's `unknown` so we narrow once here.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return factory as MetricFactory
}

const REQUIRED_FIELDS = ['name', 'direction', 'mutable_path', 'gate', 'score']

/**
 * The first problem with `value`, or `undefined` when it looks like a Metric.
 */
function metric_problem(value: unknown): string | undefined {
  if (!is_record(value)) return 'expected an object'
  const missing = REQUIRED_FIELDS.find((key) => !(key in value))
  if (missing !== undefined) return `missing required field "${missing}"`
  const direction = value['direction']
  if (direction !== 'minimize' && direction !== 'maximize') {
    return `direction must be "minimize" or "maximize", got ${String(direction)}`
  }
  if (typeof value['score'] !== 'function') return '"score" must be a function'
  return undefined
}

export function validate(value: unknown, source: string): Metric {
  const problem = metric_problem(value)
  if (problem !== undefined) throw new Error(`metric from ${source}: ${problem}`)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Metric
}

async function dynamic_import(path: string): Promise<unknown> {
  const abs = isAbsolute(path) ? path : resolve(path)
  return import(pathToFileURL(abs).href)
}

export async function load_metric(spec: string, target_dir: string): Promise<Metric> {
  if (BUILTINS.has(spec)) {
    // `metrics/` sits at the package root, two levels up from src/services/.
    const here = new URL(`../../metrics/${spec}.js`, import.meta.url)
    const mod: unknown = await import(here.href)
    const factory = get_factory(mod, `builtin:${spec}`)
    return validate(factory(target_dir), `builtin:${spec}`)
  }
  const mod: unknown = await dynamic_import(spec)
  const factory = get_factory(mod, spec)
  return validate(factory(target_dir), spec)
}
