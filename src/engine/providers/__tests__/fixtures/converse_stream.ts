/**
 * A framer for Bedrock's ConverseStream wire: the AWS event-stream encoding
 * that `@ai-sdk/amazon-bedrock` decodes with `@smithy/eventstream-codec`.
 *
 * Each message is a 12-byte prelude (the total length, the headers' length,
 * and a CRC32 of those eight bytes), the headers, the JSON payload, and a
 * CRC32 of everything before it, all big-endian. A header is its name's
 * length in one byte, the name, a type byte (7 for a string), the value's
 * length in two bytes, and the value. Every ConverseStream event carries the
 * same three headers, `:event-type`, `:content-type`, and `:message-type`.
 * The CRCs come from `node:zlib`, so the framer needs no dependency.
 *
 * `decode_event_stream` reads frames back and checks both CRCs. The peer's
 * own decoder swallows a frame that fails to decode and ends the stream
 * there, which reads as an empty turn, so a framer bug would hide behind it
 * without a decoder that fails loud.
 */

import { crc32 } from 'node:zlib'

const STRING_HEADER = 7
const PRELUDE_BYTES = 12
const CRC_BYTES = 4

/** One ConverseStream event: its `:event-type` and its JSON payload. */
export type ConverseStreamEvent = readonly [event_type: string, payload: unknown]

/** Encode one header as name length, name, string type, value length, value. */
function encode_header(name: string, value: string): Uint8Array {
  const name_bytes = new TextEncoder().encode(name)
  const value_bytes = new TextEncoder().encode(value)
  const out = new Uint8Array(1 + name_bytes.length + 1 + 2 + value_bytes.length)
  const view = new DataView(out.buffer)
  out[0] = name_bytes.length
  out.set(name_bytes, 1)
  out[1 + name_bytes.length] = STRING_HEADER
  view.setUint16(2 + name_bytes.length, value_bytes.length, false)
  out.set(value_bytes, 4 + name_bytes.length)
  return out
}

/** Join byte arrays end to end. */
function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0))
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

/** Encode one ConverseStream event as a framed event-stream message. */
export function encode_event_stream_message(event_type: string, payload: unknown): Uint8Array {
  const headers = concat([
    encode_header(':event-type', event_type),
    encode_header(':content-type', 'application/json'),
    encode_header(':message-type', 'event'),
  ])
  const body = new TextEncoder().encode(JSON.stringify(payload))
  const total = PRELUDE_BYTES + headers.length + body.length + CRC_BYTES
  const message = new Uint8Array(total)
  const view = new DataView(message.buffer)
  view.setUint32(0, total, false)
  view.setUint32(4, headers.length, false)
  view.setUint32(8, crc32(message.subarray(0, 8)), false)
  message.set(headers, PRELUDE_BYTES)
  message.set(body, PRELUDE_BYTES + headers.length)
  view.setUint32(total - CRC_BYTES, crc32(message.subarray(0, total - CRC_BYTES)), false)
  return message
}

/** Frame a sequence of events back to back, as one ConverseStream body. */
export function encode_converse_stream(events: ReadonlyArray<ConverseStreamEvent>): Uint8Array {
  return concat(events.map(([event_type, payload]) => encode_event_stream_message(event_type, payload)))
}

/**
 * A ConverseStream response whose body arrives in `slice`-byte reads, so the
 * peer's decoder has to buffer frames across reads.
 */
export function converse_stream_response(events: ReadonlyArray<ConverseStreamEvent>, slice = 17): Response {
  const bytes = encode_converse_stream(events)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += slice) controller.enqueue(bytes.slice(i, i + slice))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { 'content-type': 'application/vnd.amazon.eventstream' },
  })
}

/** One decoded frame: its string headers and its parsed JSON payload. */
export type DecodedEvent = { readonly headers: Readonly<Record<string, string>>; readonly payload: unknown }

/** Read a frame's headers, which this framer writes as strings only. */
function decode_headers(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const headers: Record<string, string> = {}
  let offset = 0
  while (offset < bytes.length) {
    const name_length = bytes[offset] ?? 0
    const name = new TextDecoder().decode(bytes.subarray(offset + 1, offset + 1 + name_length))
    const type = bytes[offset + 1 + name_length]
    if (type !== STRING_HEADER) throw new Error(`header ${name} has type ${String(type)}, not a string`)
    const value_length = view.getUint16(offset + 2 + name_length, false)
    const value_start = offset + 4 + name_length
    headers[name] = new TextDecoder().decode(bytes.subarray(value_start, value_start + value_length))
    offset = value_start + value_length
  }
  return headers
}

/**
 * Decode framed event-stream messages, throwing on a truncated frame or on a
 * prelude or message CRC that doesn't match.
 */
export function decode_event_stream(bytes: Uint8Array): DecodedEvent[] {
  const events: DecodedEvent[] = []
  let offset = 0
  while (offset < bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset + offset, bytes.byteLength - offset)
    const total = view.getUint32(0, false)
    const headers_length = view.getUint32(4, false)
    if (offset + total > bytes.length) throw new Error(`frame at ${String(offset)} is truncated`)
    const frame = bytes.subarray(offset, offset + total)
    if (view.getUint32(8, false) !== crc32(frame.subarray(0, 8))) {
      throw new Error(`frame at ${String(offset)} has a bad prelude CRC`)
    }
    if (view.getUint32(total - CRC_BYTES, false) !== crc32(frame.subarray(0, total - CRC_BYTES))) {
      throw new Error(`frame at ${String(offset)} has a bad message CRC`)
    }
    const headers = decode_headers(frame.subarray(PRELUDE_BYTES, PRELUDE_BYTES + headers_length))
    const body = frame.subarray(PRELUDE_BYTES + headers_length, total - CRC_BYTES)
    events.push({ headers, payload: JSON.parse(new TextDecoder().decode(body)) as unknown })
    offset += total
  }
  return events
}
