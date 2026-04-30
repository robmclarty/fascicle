/**
 * define_agent: markdown-driven loader for simple agents.
 *
 * Most "agents" in practice are a system prompt and an output schema with a
 * thin wrapper. `define_agent({ md_path, schema, engine, build_prompt? })`
 * folds those into a `Step<i, o>`:
 *
 * - The markdown file is read once at factory time. Its YAML-style frontmatter
 *   (`name`, `description`, `model`, `temperature`) is parsed into the agent's
 *   step name and engine call defaults; the body is the system prompt.
 * - Without `build_prompt`, the body (after `{{key}}` substitution against
 *   top-level string fields of the input) is the user prompt and no system is
 *   sent — the markdown carries the full instruction.
 * - With `build_prompt`, the body is the system prompt and `build_prompt(input)`
 *   produces the user message (string, or `{ user, system? }` to override).
 *
 * The factory keeps no engine state. Each call delegates to `engine.generate`
 * with the resolved prompts, the schema, and `ctx.abort` / `ctx.trajectory`
 * threaded through. An `agent.call` trajectory event carries the agent name,
 * resolved model id, and engine-reported usage. No retry or fallback is baked
 * in — wrap with `retry()` from core if you need it.
 *
 * Frontmatter parser is intentionally tiny (no gray-matter): bare `key: value`
 * lines, optional `'`/`"` quotes, `temperature` coerced to number. Anything
 * richer should go through `build_prompt`.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { aborted_error, step } from '@repo/core'
import type { RunContext, Step } from '@repo/core'
import type { Engine, GenerateOptions } from '@repo/engine'
import type { z } from 'zod'

export type AgentBuiltPrompt =
  | string
  | { readonly user: string; readonly system?: string }

export type DefineAgentConfig<i, o> = {
  readonly md_path: string | URL
  readonly schema: z.ZodType<o>
  readonly engine: Engine
  readonly name?: string
  readonly build_prompt?: (input: i) => AgentBuiltPrompt
}

type Frontmatter = {
  readonly name?: string
  readonly description?: string
  readonly model?: string
  readonly temperature?: number
}

type ParsedPrompt = {
  readonly frontmatter: Frontmatter
  readonly body: string
}

const FRONTMATTER_OPEN = /^---\s*\r?\n/
const FRONTMATTER_CLOSE = /^---\s*$/m
const PLACEHOLDER_RE = /\{\{(\w+)\}\}/g

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

function parse_frontmatter(content: string): ParsedPrompt {
  const open_match = content.match(FRONTMATTER_OPEN)
  if (!open_match) return { frontmatter: {}, body: content }
  const after_open = content.slice(open_match[0].length)
  const close_match = FRONTMATTER_CLOSE.exec(after_open)
  if (close_match?.index === undefined) {
    throw new Error('define_agent: malformed frontmatter (missing closing `---`)')
  }
  const yaml_block = after_open.slice(0, close_match.index)
  const body = after_open.slice(close_match.index + close_match[0].length).replace(/^\r?\n/, '')

  const out: { -readonly [K in keyof Frontmatter]: Frontmatter[K] } = {}
  const lines = yaml_block.split(/\r?\n/)
  for (const raw of lines) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const colon_idx = line.indexOf(':')
    if (colon_idx === -1) {
      throw new Error(`define_agent: malformed frontmatter line: ${raw}`)
    }
    const key = line.slice(0, colon_idx).trim()
    const value_raw = line.slice(colon_idx + 1).trim()
    const value = unquote(value_raw)
    if (key === 'name' || key === 'description' || key === 'model') {
      out[key] = value
      continue
    }
    if (key === 'temperature') {
      const n = Number(value)
      if (!Number.isFinite(n)) {
        throw new Error(`define_agent: temperature must be a number, got: ${value_raw}`)
      }
      out.temperature = n
      continue
    }
  }
  return { frontmatter: out, body }
}

function read_md_sync(path: string | URL): string {
  if (path instanceof URL) {
    return readFileSync(fileURLToPath(path), 'utf8')
  }
  if (path.startsWith('file://')) {
    return readFileSync(fileURLToPath(path), 'utf8')
  }
  return readFileSync(path, 'utf8')
}

function substitute(template: string, input: unknown): string {
  if (input === null || typeof input !== 'object') return template
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const obj = input as Record<string, unknown>
  return template.replace(PLACEHOLDER_RE, (match, key: string) => {
    const v = obj[key]
    return typeof v === 'string' ? v : match
  })
}

export function define_agent<i, o>(config: DefineAgentConfig<i, o>): Step<i, o> {
  const text = read_md_sync(config.md_path)
  const { frontmatter, body } = parse_frontmatter(text)

  const display_name = config.name ?? frontmatter.name ?? 'agent'

  return step<i, o>(display_name, async (input, ctx: RunContext): Promise<o> => {
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
    if (frontmatter.model !== undefined) opts.model = frontmatter.model
    if (frontmatter.temperature !== undefined) opts.temperature = frontmatter.temperature
  
    const result = await config.engine.generate<o>(opts)
  
    const resolved_model = `${result.model_resolved.provider}:${result.model_resolved.model_id}`
    ctx.trajectory.record({
      kind: 'agent.call',
      name: display_name,
      model: resolved_model,
      usage: result.usage,
    })
  
    return result.content
  })
}
