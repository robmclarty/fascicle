/**
 * Building and reading A2A parts.
 *
 * A part holds exactly one of text, raw bytes, a URL, or a JSON value. The
 * SDK's types are protobuf-shaped, so the content sits under a `$case`, and
 * raw bytes are a `Buffer`. Nothing here needs an SDK value: a part is plain
 * data, which is what lets the mapper in to_task_events.ts stay pure.
 *
 * `to_plain` and `from_plain` carry a value that may hold raw bytes through
 * JSON, for the stores a task record and a checkpoint are kept in.
 */

import type { Part } from '@a2a-js/sdk'
import { is_record } from '#schema'
import type { A2aFile } from './types.js'

const BYTES = '$bytes'

/**
 * A text part.
 */
export function text_part(text: string): Part {
  return { content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: 'text/plain' }
}

/**
 * A data part holding any JSON value.
 */
export function data_part(value: unknown): Part {
  return { content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: 'application/json' }
}

/**
 * The default `to_parts`: a string as a text part, nothing for a flow that
 * returns nothing, and anything else as a data part.
 */
export function output_parts(output: unknown): Part[] {
  if (typeof output === 'string') return [text_part(output)]
  if (output === undefined || output === null) return []
  return [data_part(output)]
}

/**
 * The text parts among `parts`, joined with `separator`.
 */
export function text_of(parts: ReadonlyArray<Part>, separator = ''): string {
  const texts: string[] = []
  for (const part of parts) {
    if (part.content?.$case === 'text') texts.push(part.content.value)
  }
  return texts.join(separator)
}

/**
 * The values of the data parts among `parts`, in order.
 */
export function data_of(parts: ReadonlyArray<Part>): unknown[] {
  const values: unknown[] = []
  for (const part of parts) {
    if (part.content?.$case === 'data') values.push(part.content.value)
  }
  return values
}

/**
 * The file parts among `parts` (the ones that carry bytes or a URL), with
 * bytes as base64 so that they survive a trip through a store.
 */
export function files_of(parts: ReadonlyArray<Part>): A2aFile[] {
  const files: A2aFile[] = []
  for (const part of parts) {
    const base = { filename: part.filename, media_type: part.mediaType }
    if (part.content?.$case === 'url') files.push({ ...base, url: part.content.value })
    if (part.content?.$case === 'raw') {
      files.push({ ...base, base64: Buffer.from(part.content.value).toString('base64') })
    }
  }
  return files
}

/**
 * A copy of `value` that JSON can hold, with every run of raw bytes written
 * as `{ $bytes: <base64> }`.
 */
export function to_plain(value: unknown): unknown {
  if (value instanceof Uint8Array) return { [BYTES]: Buffer.from(value).toString('base64') }
  if (Array.isArray(value)) return value.map(to_plain)
  if (!is_record(value)) return value
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, to_plain(inner)]))
}

/**
 * The inverse of `to_plain`: every `{ $bytes }` it wrote becomes a `Buffer`
 * again.
 */
export function from_plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(from_plain)
  if (!is_record(value)) return value
  const bytes = value[BYTES]
  if (typeof bytes === 'string' && Object.keys(value).length === 1) return Buffer.from(bytes, 'base64')
  return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, from_plain(inner)]))
}
