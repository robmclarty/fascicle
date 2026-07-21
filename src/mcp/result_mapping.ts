/**
 * Mapping between MCP `CallToolResult` payloads and fascicle tool values, in
 * both directions: inbound results from `mcp_client` tools, outbound results
 * for `serve_flow`.
 */

import { mcp_error } from './errors.js'
import { as_record, is_record } from './internal.js'

export type McpToolResult = {
  content: Array<{ type: 'text'; text: string }>
  structuredContent?: Record<string, unknown>
}

/**
 * Converts a remote tool's `CallToolResult` into the value a fascicle
 * `Tool.execute` returns.
 *
 * `isError: true` marks a tool-level failure, so it throws `mcp_error` rather
 * than returning, letting the tool loop's error policy feed it back to the
 * model. `structuredContent` is preferred over joined text parts when present;
 * with neither, the raw `content` (or `null`) is returned.
 */
export function call_result_to_output(result: unknown, tool_name?: string): unknown {
  const record = as_record(result) ?? {}

  if (record['isError'] === true) {
    const detail = join_text(record['content']) ?? 'MCP tool returned an error'
    throw new mcp_error(detail, tool_name !== undefined ? { tool_name } : {})
  }

  if (is_record(record['structuredContent'])) return record['structuredContent']

  const text = join_text(record['content'])
  if (text !== undefined) return text

  return record['content'] ?? null
}

/**
 * Converts a fascicle flow's output into a `CallToolResult` for `serve_flow`.
 *
 * A `to_result` override takes precedence over the default mapping. By
 * default, objects are emitted as both a JSON text part (every MCP host can
 * read text) and `structuredContent` (typed hosts get the object); everything
 * else becomes a single text part.
 */
export function output_to_call_result<o>(
  output: o,
  to_result?: (output: o) => { text: string; structured?: Record<string, unknown> },
): McpToolResult {
  if (to_result !== undefined) {
    const shaped = to_result(output)
    return build_result(shaped.text, shaped.structured)
  }
  if (typeof output === 'string') return build_result(output)
  if (is_record(output)) return build_result(stringify(output), output)
  if (Array.isArray(output)) return build_result(stringify(output))
  return build_result(String(output))
}

/**
 * Assembles a `CallToolResult` with one text part and, when given, structured
 * content.
 */
function build_result(text: string, structured?: Record<string, unknown>): McpToolResult {
  return structured !== undefined
    ? { content: [{ type: 'text', text }], structuredContent: structured }
    : { content: [{ type: 'text', text }] }
}

/**
 * Joins the `text` parts of an MCP content array with newlines, skipping
 * non-text parts; `undefined` when there is nothing to join.
 */
function join_text(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const part of content) {
    if (is_record(part) && part['type'] === 'text' && typeof part['text'] === 'string') {
      parts.push(part['text'])
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined
}

/**
 * `JSON.stringify` that falls back to `String` instead of throwing on
 * unserializable values (circular references, BigInt).
 */
function stringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
