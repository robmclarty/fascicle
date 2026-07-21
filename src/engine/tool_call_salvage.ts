/**
 * Salvage tool calls that a model emitted as assistant TEXT instead of a
 * structured tool_calls array. Local runtimes (Ollama native API, LM Studio
 * /v1) frequently mis-serialize tool definitions in the chat template, so the
 * model writes its call into the content in one of three well-known formats:
 *
 *   hermes    <tool_call>{"name":"x","arguments":{...}}</tool_call>
 *   json      {"name":"x","arguments":{...}}   bare or ```json-fenced
 *   qwen_xml  <tool_call><function=x><parameter=k>v</parameter></function></tool_call>
 *
 * A candidate is accepted ONLY when its name resolves in the call's tool
 * registry AND its arguments validate against that tool's zod input_schema.
 * That double gate is the guard against a false positive on an ordinary
 * answer that merely contains JSON.
 *
 * Parsing rules that matter for correctness:
 *   - Every <tool_call> block extent, accepted or rejected, is masked so the
 *     bare-JSON pass never re-matches a payload inside it (a hermes block
 *     contains a shape-valid bare object; double-matching would double-strip).
 *   - All code fences are masked from the bare pass for the same reason;
 *     only fences with no info string or `json` are parsed as candidates.
 *   - A complete bare object that is not a call is skipped whole: descending
 *     into it could false-positive on substructures of ordinary JSON output.
 *   - An unterminated <tool_call> is ignored (finish_reason 'length'
 *     truncation); its text is left intact.
 *   - Qwen XML parameter values that contain a literal </parameter> mis-parse
 *     under the non-greedy matcher; accepted limitation.
 *
 * Never throws; returns undefined when zero candidates survive validation.
 */

import type { z } from 'zod'
import type { SalvageFormat, Tool } from './types.js'

export type SalvagedCall = {
  readonly name: string
  readonly input: unknown
  readonly format: SalvageFormat
  readonly span: { readonly start: number; readonly end: number }
}

export type SalvageOutcome = {
  readonly calls: ReadonlyArray<SalvagedCall>
  readonly stripped_text: string
}

type Span = { readonly start: number; readonly end: number }

type Candidate = {
  readonly name: string
  readonly args: Record<string, unknown>
  readonly format: SalvageFormat
  readonly span: Span
}

const TOOL_CALL_OPEN = '<tool_call>'
const TOOL_CALL_CLOSE = '</tool_call>'
const FUNCTION_RE = /<function=([^>\s]+)>([\s\S]*?)<\/function>/g
const PARAMETER_RE = /<parameter=([^>\s]+)>([\s\S]*?)<\/parameter>/g
const FENCE_RE = /```([^\n]*)\n([\s\S]*?)```/g
const EMPTY_BLOCK_RE = /<tool_call>\s*<\/tool_call>/g

/**
 * Find the extent of one balanced JSON object starting at `start_index`
 * (which must point at `{`), respecting strings and escapes so braces inside
 * string values do not affect the depth count. The scanner only finds the
 * extent; JSON.parse remains the sole semantic authority.
 */
export function scan_balanced_json(
  text: string,
  start_index: number,
): { value: unknown; end: number } | undefined {
  if (text[start_index] !== '{') return undefined
  let depth = 0
  let in_string = false
  let escaped = false
  for (let i = start_index; i < text.length; i += 1) {
    const ch = text[i]
    if (in_string) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') in_string = false
      continue
    }
    if (ch === '"') {
      in_string = true
    } else if (ch === '{') {
      depth += 1
    } else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        const end = i + 1
        try {
          return { value: JSON.parse(text.slice(start_index, end)), end }
        } catch {
          return undefined
        }
      }
    }
  }
  return undefined
}

/**
 * Check for a non-null, non-array object.
 */
function is_plain_object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Exactly {name, arguments} with a string name and object arguments. This is
 * the shape firewall against prose that happens to contain JSON.
 */
function call_shape(
  value: unknown,
): { name: string; args: Record<string, unknown> } | undefined {
  if (!is_plain_object(value)) return undefined
  if (Object.keys(value).length !== 2) return undefined
  const name = value['name']
  const args = value['arguments']
  if (typeof name !== 'string' || !is_plain_object(args)) return undefined
  return { name, args }
}

/**
 * Check whether a span intersects any masked region.
 */
function overlaps_any(span: Span, masks: ReadonlyArray<Span>): boolean {
  return masks.some((m) => span.start < m.end && m.start < span.end)
}

/**
 * Find the mask covering a text index, if any, so scanners can jump past it.
 */
function mask_containing(masks: ReadonlyArray<Span>, index: number): Span | undefined {
  return masks.find((m) => index >= m.start && index < m.end)
}

/**
 * Strip at most one leading and one trailing newline.
 *
 * Qwen XML parameter values are written on their own lines; the wrapping
 * newlines are markup, but interior whitespace is real data and stays.
 */
function trim_one_newline(value: string): string {
  let out = value
  if (out.startsWith('\n')) out = out.slice(1)
  if (out.endsWith('\n')) out = out.slice(0, -1)
  return out
}

/**
 * Extract qwen_xml `<function=name>` candidates from a tool_call block body.
 *
 * Parameters land as a string map (typed coercion happens at validation).
 * Spans are offset by `inner_start` back into the full-text coordinate space.
 */
function scan_qwen_functions(inner_start: number, inner: string): Candidate[] {
  const out: Candidate[] = []
  for (const fn of inner.matchAll(FUNCTION_RE)) {
    const body = fn[2] ?? ''
    const params: Record<string, string> = {}
    let leftover = body
    for (const pm of body.matchAll(PARAMETER_RE)) {
      params[pm[1] ?? ''] = trim_one_newline(pm[2] ?? '')
      leftover = leftover.replace(pm[0], '')
    }
    // Non-whitespace between parameter tags means the block is not a clean
    // call; skip it rather than guess at intent.
    if (leftover.trim().length !== 0) continue
    out.push({
      name: fn[1] ?? '',
      args: params,
      format: 'qwen_xml',
      span: { start: inner_start + fn.index, end: inner_start + fn.index + fn[0].length },
    })
  }
  return out
}

/**
 * Scan `<tool_call>` blocks for hermes and qwen_xml candidates.
 *
 * Every block extent (accepted, rejected, or unterminated) is returned as a
 * mask so later passes never re-match payloads inside it.
 */
function scan_tool_call_blocks(text: string): { candidates: Candidate[]; masks: Span[] } {
  const candidates: Candidate[] = []
  const masks: Span[] = []
  let pos = 0
  while (true) {
    const open = text.indexOf(TOOL_CALL_OPEN, pos)
    if (open === -1) break
    const close = text.indexOf(TOOL_CALL_CLOSE, open + TOOL_CALL_OPEN.length)
    if (close === -1) {
      // Unterminated block, likely 'length' truncation. Mask to end of text
      // so the bare pass cannot salvage a fragment of an incomplete call.
      masks.push({ start: open, end: text.length })
      break
    }
    const block_end = close + TOOL_CALL_CLOSE.length
    masks.push({ start: open, end: block_end })
    const inner_start = open + TOOL_CALL_OPEN.length
    const inner = text.slice(inner_start, close)
    const trimmed = inner.trim()
    if (trimmed.startsWith('<function=')) {
      candidates.push(...scan_qwen_functions(inner_start, inner))
    } else if (trimmed.startsWith('{')) {
      const brace = text.indexOf('{', inner_start)
      const scanned = brace === -1 ? undefined : scan_balanced_json(text, brace)
      const shaped = scanned === undefined ? undefined : call_shape(scanned.value)
      if (shaped !== undefined) {
        candidates.push({
          name: shaped.name,
          args: shaped.args,
          format: 'hermes',
          span: { start: open, end: block_end },
        })
      }
    }
    pos = block_end
  }
  return { candidates, masks }
}

/**
 * Scan code fences for JSON-format candidates.
 *
 * All fences become masks (keeping the bare pass out of code samples), but
 * only fences with no info string or `json` are parsed as candidates.
 */
function scan_fences(
  text: string,
  block_masks: ReadonlyArray<Span>,
): { candidates: Candidate[]; masks: Span[] } {
  const candidates: Candidate[] = []
  const masks: Span[] = []
  for (const m of text.matchAll(FENCE_RE)) {
    const span: Span = { start: m.index, end: m.index + m[0].length }
    if (overlaps_any(span, block_masks)) continue
    masks.push(span)
    const info = (m[1] ?? '').trim()
    if (info !== '' && info !== 'json') continue
    let value: unknown
    try {
      value = JSON.parse((m[2] ?? '').trim())
    } catch {
      continue
    }
    const shaped = call_shape(value)
    if (shaped === undefined) continue
    candidates.push({ name: shaped.name, args: shaped.args, format: 'json', span })
  }
  return { candidates, masks }
}

/**
 * Scan unmasked text for bare `{name, arguments}` JSON objects.
 *
 * A complete object that is not call-shaped is skipped whole rather than
 * descended into, so substructures of ordinary JSON output cannot
 * false-positive.
 */
function scan_bare_json(text: string, masks: ReadonlyArray<Span>): Candidate[] {
  const out: Candidate[] = []
  let i = 0
  while (i < text.length) {
    const masked = mask_containing(masks, i)
    if (masked !== undefined) {
      i = masked.end
      continue
    }
    if (text[i] !== '{') {
      i += 1
      continue
    }
    const scanned = scan_balanced_json(text, i)
    if (scanned === undefined) {
      i += 1
      continue
    }
    const span: Span = { start: i, end: scanned.end }
    const shaped = overlaps_any(span, masks) ? undefined : call_shape(scanned.value)
    if (shaped !== undefined) {
      out.push({ name: shaped.name, args: shaped.args, format: 'json', span })
    }
    i = scanned.end
  }
  return out
}

/**
 * Promote a candidate to a `SalvagedCall` when its tool exists and its
 * arguments validate.
 *
 * This is the second half of the double gate described in the header.
 * qwen_xml candidates get one retry with per-parameter JSON coercion, since
 * XML parameter values always arrive as strings.
 */
function validate_candidate(
  candidate: Candidate,
  tool_map: ReadonlyMap<string, Tool>,
): SalvagedCall | undefined {
  const tool = tool_map.get(candidate.name)
  if (tool === undefined) return undefined
  const schema: z.ZodType = tool.input_schema
  const raw = schema.safeParse(candidate.args)
  if (raw.success) {
    return {
      name: candidate.name,
      input: raw.data,
      format: candidate.format,
      span: candidate.span,
    }
  }
  if (candidate.format !== 'qwen_xml') return undefined
  // XML parameters arrive as strings; retry once with per-param JSON coercion
  // so numbers, booleans, and nested structures can validate. Raw-first order
  // keeps z.string() params as the literal string they were written as.
  const coerced: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(candidate.args)) {
    if (typeof v !== 'string') {
      coerced[k] = v
      continue
    }
    try {
      coerced[k] = JSON.parse(v)
    } catch {
      coerced[k] = v
    }
  }
  const retried = schema.safeParse(coerced)
  if (!retried.success) return undefined
  return {
    name: candidate.name,
    input: retried.data,
    format: candidate.format,
    span: candidate.span,
  }
}

/**
 * Remove the accepted calls' spans from the text, back to front so earlier
 * offsets stay valid, then drop any emptied `<tool_call>` wrappers.
 */
function strip_spans(text: string, spans: ReadonlyArray<Span>): string {
  let out = text
  const descending = spans.toSorted((a, b) => b.start - a.start)
  for (const s of descending) out = out.slice(0, s.start) + out.slice(s.end)
  // Qwen candidates strip only their <function=> extent; drop a wrapper left
  // empty so history does not retain dangling markup.
  return out.replace(EMPTY_BLOCK_RE, '').trim()
}

/**
 * Recover tool calls from assistant text, per the header's format rules.
 *
 * Runs the three scanners in masking order (blocks, fences, bare JSON),
 * validates every candidate against the tool registry, and returns the
 * surviving calls plus the text with their spans stripped. Returns undefined
 * when nothing survives.
 */
export function salvage_tool_calls(
  text: string,
  tool_map: ReadonlyMap<string, Tool>,
): SalvageOutcome | undefined {
  if (text.length === 0) return undefined
  const blocks = scan_tool_call_blocks(text)
  const fences = scan_fences(text, blocks.masks)
  const all_masks = [...blocks.masks, ...fences.masks]
  const candidates = [
    ...blocks.candidates,
    ...fences.candidates,
    ...scan_bare_json(text, all_masks),
  ].toSorted((a, b) => a.span.start - b.span.start)

  const calls: SalvagedCall[] = []
  for (const c of candidates) {
    const validated = validate_candidate(c, tool_map)
    if (validated !== undefined) calls.push(validated)
  }
  if (calls.length === 0) return undefined
  return {
    calls,
    stripped_text: strip_spans(
      text,
      calls.map((c) => c.span),
    ),
  }
}
