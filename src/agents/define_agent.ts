/**
 * define_agent: markdown-driven loader for simple agents.
 *
 * Most "agents" in practice are a system prompt and an output schema with a
 * thin wrapper. `define_agent({ md_path, schema, engine, build_prompt? })`
 * folds those into a `Step<i, o>`:
 *
 * - The markdown file is read once at factory time. Its YAML-style frontmatter
 *   (`name`, `description`, `model`, `provider`, `effort`, `temperature`,
 *   `max_tokens`, `top_p`) is parsed into the agent's step name and engine
 *   call defaults; the body is the system prompt.
 * - Without `build_prompt`, the body (after `{{key}}` substitution against
 *   top-level string fields of the input) is the user prompt and no system is
 *   sent; the markdown carries the full instruction.
 * - With `build_prompt`, the body is the system prompt and `build_prompt(input)`
 *   produces the user message (string, or `{ user, system? }` to override).
 * - `config.model`, `config.provider`, `config.effort`, `config.temperature`,
 *   `config.max_tokens`, `config.top_p`, and `config.schema_repair_attempts`
 *   shape the call from code. Code wins over frontmatter (frontmatter stays
 *   the role default when the app threads nothing; the engine default is the
 *   last resort), so a resolved role-to-model table and env overrides actually
 *   reach the call.
 *
 * The factory keeps no engine state. Each call delegates to `engine.generate`
 * with the resolved prompts, the schema, and `ctx.abort` / `ctx.trajectory`
 * threaded through. An `agent.call` trajectory event carries the agent id and
 * display name, resolved model id, and engine-reported usage. Identity and
 * display stay separate: `config.id` is the step id and must be
 * identifier-shaped, while `config.name` is free prose that labels the span.
 * No retry or fallback is baked
 * in; wrap with `retry()` from core if you need it.
 *
 * Frontmatter parser is intentionally tiny (no gray-matter): bare `key: value`
 * lines, optional `'`/`"` quotes, `temperature`/`max_tokens`/`top_p` coerced
 * to number, `effort` validated against the engine's levels. Anything richer
 * should go through `build_prompt`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aborted_error, assert_valid_step_id, step } from '#core'
import type { RunContext, Step } from '#core'
import type { EffortLevel, Engine, GenerateOptions } from '#engine'
import type { ToolSchema } from '#schema'

export type AgentBuiltPrompt =
  | string
  | { readonly user: string; readonly system?: string }

export type DefineAgentConfig<i, o> = {
  readonly md_path: string | URL
  readonly schema: ToolSchema<o>
  readonly engine: Engine
  /**
   * Display label for the agent's span, `describe` line, and `agent.call`
   * event. Free prose. Defaults to the frontmatter `name`.
   */
  readonly name?: string
  /**
   * Step id for the agent, which must be identifier-shaped. Defaults to the
   * resolved display name, so an agent whose label is already a plain
   * identifier needs nothing here; set it explicitly when the label is prose.
   */
  readonly id?: string
  readonly build_prompt?: (input: i) => AgentBuiltPrompt
  /**
   * Model for this agent's calls, typically threaded from the app's resolved
   * role-to-model table. Wins over frontmatter `model`; when both are absent
   * the engine default applies.
   */
  readonly model?: string
  /**
   * Transport for the model. Same precedence as `model`: code wins over
   * frontmatter `provider`, and the engine default is the last resort.
   */
  readonly provider?: string
  /** Reasoning effort for the call. Wins over frontmatter `effort`. */
  readonly effort?: EffortLevel
  /** Sampling temperature. Wins over frontmatter `temperature`. */
  readonly temperature?: number
  /** Output token cap. Wins over frontmatter `max_tokens`. */
  readonly max_tokens?: number
  /** Nucleus sampling cutoff. Wins over frontmatter `top_p`. */
  readonly top_p?: number
  /**
   * Forwarded to `engine.generate`: how many times the engine may re-prompt
   * the model to repair schema-invalid output before failing the call.
   */
  readonly schema_repair_attempts?: number
}

type Frontmatter = {
  readonly name?: string
  readonly description?: string
  readonly model?: string
  readonly provider?: string
  readonly effort?: EffortLevel
  readonly temperature?: number
  readonly max_tokens?: number
  readonly top_p?: number
}

type ParsedPrompt = {
  readonly frontmatter: Frontmatter
  readonly body: string
}

const FRONTMATTER_OPEN = /^---\s*\r?\n/
const FRONTMATTER_CLOSE = /^---\s*$/m
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

/**
 * Strip one matching pair of surrounding single or double quotes.
 */
function unquote(raw: string): string {
  if (raw.length >= 2) {
    const first = raw[0]
    const last = raw[raw.length - 1]
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return raw.slice(1, -1)
    }
  }
  return raw
}

type MutableFrontmatter = { -readonly [K in keyof Frontmatter]: Frontmatter[K] }

/**
 * Locate the frontmatter block and split it from the body.
 *
 * Returns `null` when there is no opening `---` (the file is all body).
 * A block opened but never closed throws rather than silently producing a
 * wrong prompt.
 */
function split_frontmatter(
  content: string,
): { readonly yaml_block: string; readonly body: string } | null {
  const open_match = content.match(FRONTMATTER_OPEN)
  if (!open_match) return null
  const after_open = content.slice(open_match[0].length)
  const close_match = FRONTMATTER_CLOSE.exec(after_open)
  if (close_match?.index === undefined) {
    throw new Error('define_agent: malformed frontmatter (missing closing `---`)')
  }
  const yaml_block = after_open.slice(0, close_match.index)
  const body = after_open.slice(close_match.index + close_match[0].length).replace(/^\r?\n/, '')
  return { yaml_block, body }
}

/**
 * Coerce a numeric frontmatter value to a finite number, throwing on anything
 * else. `raw` is the pre-unquote text, so the error message echoes what the
 * file held.
 */
function parse_number(key: string, value: string, raw: string): number {
  const n = Number(value)
  if (!Number.isFinite(n)) {
    throw new Error(`define_agent: ${key} must be a number, got: ${raw}`)
  }
  return n
}

// A Record keyed by EffortLevel so tsc flags this table whenever the engine's
// union gains or loses a member; the runtime lookup then validates frontmatter.
const EFFORT_LEVELS: Readonly<Record<EffortLevel, true>> = {
  none: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
}

/**
 * Validate an `effort` value against the engine's `EffortLevel` union,
 * throwing at factory time so a typo'd level never reaches a live call.
 */
function parse_effort(value: string, raw: string): EffortLevel {
  if (!Object.hasOwn(EFFORT_LEVELS, value)) {
    throw new Error(
      `define_agent: effort must be one of ${Object.keys(EFFORT_LEVELS).join(', ')}, got: ${raw}`,
    )
  }
  // The hasOwn check above proves membership in the union.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return value as EffortLevel
}

/**
 * Parse one `key: value` frontmatter line into `out`. Blank and `#` comment
 * lines are skipped; a line without a colon throws; unrecognized keys are
 * ignored so only the `Frontmatter` fields reach the agent.
 */
function assign_frontmatter_field(out: MutableFrontmatter, raw: string): void {
  const line = raw.trim()
  if (line === '' || line.startsWith('#')) return
  const colon_idx = line.indexOf(':')
  if (colon_idx === -1) {
    throw new Error(`define_agent: malformed frontmatter line: ${raw}`)
  }
  const key = line.slice(0, colon_idx).trim()
  const value_raw = line.slice(colon_idx + 1).trim()
  const value = unquote(value_raw)
  if (key === 'name' || key === 'description' || key === 'model' || key === 'provider') {
    out[key] = value
    return
  }
  if (key === 'temperature' || key === 'max_tokens' || key === 'top_p') {
    out[key] = parse_number(key, value, value_raw)
    return
  }
  if (key === 'effort') {
    out.effort = parse_effort(value, value_raw)
  }
}

/**
 * Split a markdown file into frontmatter fields and prompt body.
 *
 * Parses only the flat `key: value` subset of YAML that agent files need:
 * recognized keys are `name`, `description`, `model`, `provider`, `effort`
 * (validated against the engine's levels), and `temperature`/`max_tokens`/
 * `top_p` (coerced to numbers); unrecognized keys are ignored. A file without
 * an opening `---` is all body. Malformed frontmatter throws rather than
 * silently producing a wrong prompt.
 */
function parse_frontmatter(content: string): ParsedPrompt {
  const split = split_frontmatter(content)
  if (split === null) return { frontmatter: {}, body: content }
  const out: MutableFrontmatter = {}
  for (const raw of split.yaml_block.split(/\r?\n/)) {
    assign_frontmatter_field(out, raw)
  }
  return { frontmatter: out, body: split.body }
}

/**
 * Read the markdown file from a filesystem path, `URL`, or `file://` string.
 *
 * Accepting all three lets callers pass `new URL('./x.md', import.meta.url)`
 * or its string form without caring about the difference.
 */
function read_md_sync(path: string | URL): string {
  if (path instanceof URL) {
    return readFileSync(fileURLToPath(path), 'utf8')
  }
  if (path.startsWith('file://')) {
    return readFileSync(fileURLToPath(path), 'utf8')
  }
  return readFileSync(path, 'utf8')
}

/**
 * Replace `{{key}}` placeholders with top-level string fields of the input.
 *
 * Non-string values and unknown keys leave the placeholder untouched, so a
 * typo'd placeholder is visible in the sent prompt instead of vanishing.
 */
function substitute(template: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return template
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const obj = input as Record<string, unknown>
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const v = obj[key]
    return typeof v === 'string' ? v : match
  })
}

/**
 * Fold the caller-shaped generation knobs onto `opts` with code config
 * winning over frontmatter (the precedence `model` has always used; the
 * engine default stays the last resort). Unset knobs leave their key off the
 * options object entirely rather than present-as-undefined.
 */
function apply_call_knobs<i, o>(
  opts: GenerateOptions<o>,
  config: DefineAgentConfig<i, o>,
  frontmatter: Frontmatter,
): void {
  const model = config.model ?? frontmatter.model
  if (model !== undefined) opts.model = model
  const provider = config.provider ?? frontmatter.provider
  if (provider !== undefined) opts.provider = provider
  const effort = config.effort ?? frontmatter.effort
  if (effort !== undefined) opts.effort = effort
  const temperature = config.temperature ?? frontmatter.temperature
  if (temperature !== undefined) opts.temperature = temperature
  const max_tokens = config.max_tokens ?? frontmatter.max_tokens
  if (max_tokens !== undefined) opts.max_tokens = max_tokens
  const top_p = config.top_p ?? frontmatter.top_p
  if (top_p !== undefined) opts.top_p = top_p
}

/**
 * Load a markdown-defined agent as a `Step<i, o>`.
 *
 * Reads and parses the file once at factory time; each run resolves the
 * user/system prompts (via `build_prompt` or `{{key}}` substitution), calls
 * `engine.generate` with the schema and threaded abort/trajectory, and
 * records an `agent.call` event with the resolved model and usage.
 */
export function define_agent<i, o>(config: DefineAgentConfig<i, o>): Step<i, o> {
  const text = read_md_sync(config.md_path)
  const { frontmatter, body } = parse_frontmatter(text)

  const display_name = config.name ?? frontmatter.name ?? 'agent'
  const id = config.id ?? display_name
  assert_valid_step_id(
    id,
    'define_agent: agent id',
    'pass config.id and leave the prose spelling in config.name',
  )

  const run_agent = async (input: i, ctx: RunContext): Promise<o> => {
    if (ctx.abort.aborted) {
      throw new aborted_error('aborted before agent call')
    }
  
    let user_prompt: string
    let system_prompt: string | undefined
    if (config.build_prompt) {
      const built = config.build_prompt(input)
      if (typeof built === 'string') {
        user_prompt = built
        system_prompt = body
      } else {
        user_prompt = built.user
        system_prompt = built.system ?? body
      }
    } else {
      user_prompt = substitute(body, input)
      system_prompt = undefined
    }
  
    const opts: GenerateOptions<o> = {
      prompt: user_prompt,
      schema: config.schema,
      abort: ctx.abort,
      trajectory: ctx.trajectory,
    }
    if (system_prompt !== undefined && system_prompt !== '') {
      opts.system = system_prompt
    }
    apply_call_knobs(opts, config, frontmatter)
    if (config.schema_repair_attempts !== undefined) {
      opts.schema_repair_attempts = config.schema_repair_attempts
    }
  
    const result = await config.engine.generate<o>(opts)
  
    const resolved_model = `${result.model_resolved.provider}:${result.model_resolved.model_id}`
    ctx.trajectory.record({
      kind: 'agent.call',
      id,
      name: display_name,
      model: resolved_model,
      usage: result.usage,
    })
  
    return result.content
  }

  return id === display_name
    ? step<i, o>(id, run_agent)
    : step<i, o>(id, run_agent, { name: display_name })
}
