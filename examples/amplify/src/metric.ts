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

import type { Metric } from './types.js'

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

function validate(value: unknown, source: string): Metric {
  if (!is_record(value)) {
    throw new Error(`metric from ${source}: expected an object`)
  }
  const required = ['name', 'direction', 'mutable_path', 'gate', 'score']
  for (const key of required) {
    if (!(key in value)) {
      throw new Error(`metric from ${source}: missing required field "${key}"`)
    }
  }
  const direction = value['direction']
  if (direction !== 'minimize' && direction !== 'maximize') {
    throw new Error(
      `metric from ${source}: direction must be "minimize" or "maximize", got ${String(direction)}`,
    )
  }
  if (typeof value['score'] !== 'function') {
    throw new Error(`metric from ${source}: "score" must be a function`)
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as Metric
}

async function dynamic_import(path: string): Promise<unknown> {
  const abs = isAbsolute(path) ? path : resolve(path)
  return import(pathToFileURL(abs).href)
}

export async function load_metric(spec: string, target_dir: string): Promise<Metric> {
  if (BUILTINS.has(spec)) {
    const here = new URL(`../metrics/${spec}.js`, import.meta.url)
    const mod: unknown = await import(here.href)
    const factory = get_factory(mod, `builtin:${spec}`)
    return validate(factory(target_dir), `builtin:${spec}`)
  }
  const mod: unknown = await dynamic_import(spec)
  const factory = get_factory(mod, spec)
  return validate(factory(target_dir), spec)
}
