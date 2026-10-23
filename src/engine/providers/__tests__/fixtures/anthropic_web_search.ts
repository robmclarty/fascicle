/**
 * A web search turn on the Messages API, whole and streamed, for the opaque
 * block and citation round trips.
 *
 * The stream is transcribed from the "Streaming request with web search tool
 * use" example in Anthropic's streaming docs
 * (https://platform.claude.com/docs/en/build-with-claude/streaming, read
 * 2026-10-22), event for event and byte for byte, the `ping` and the spacing
 * in one `content_block_stop` included. The docs elide parts of the example,
 * so the transcription closes them up: the search result list holds the one
 * result shown, and the text block at index 3 ends after the deltas shown.
 * One block is added that the example leaves out: a cited text block at index
 * 4, whose citation arrives as a `citations_delta`, shaped as Anthropic's web
 * search docs give a `web_search_result_location`. Its `stop_reason` is a
 * parameter, so a test can serve the same turn as a `pause_turn`.
 *
 * `web_search_json` is the whole response that the stream folds to, written
 * with each text block's keys in the order the adapter writes them back, so a
 * round trip can compare the blocks as JSON text.
 */

const RESULT = {
  type: 'web_search_result',
  title: 'Weather in New York City in May 2025 (New York) - detailed Weather Forecast for a month',
  url: 'https://world-weather.info/forecast/usa/new_york/may-2025/',
  encrypted_content: 'Ev0DCioIAxgCIiQ3NmU4ZmI4OC1k...',
  page_age: null,
}

const CITATION = {
  type: 'web_search_result_location',
  cited_text: 'Weather in New York City in May 2025',
  url: 'https://world-weather.info/forecast/usa/new_york/may-2025/',
  title: 'Weather in New York City in May 2025 (New York) - detailed Weather Forecast for a month',
  encrypted_index: 'Eo8BCioIAhgBIiQyYjQ0OWJmZi1lNm..',
}

const USAGE_START = {
  input_tokens: 2679,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 3,
}

const USAGE_END = {
  input_tokens: 10682,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: 510,
  server_tool_use: { web_search_requests: 1 },
}

/** The whole Messages response that the stream below folds to. */
export function web_search_json(stop_reason = 'end_turn'): Record<string, unknown> {
  return {
    id: 'msg_01G...',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5-5',
    content: [
      { type: 'text', text: "I'll check the current weather in New York City for you." },
      {
        type: 'server_tool_use',
        id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB',
        name: 'web_search',
        input: { query: 'weather NYC today' },
      },
      {
        type: 'web_search_tool_result',
        tool_use_id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB',
        content: [RESULT],
      },
      { type: 'text', text: "Here's the current weather information for New York City:\n\n# Weather in New York City\n\n" },
      { type: 'text', text: 'It is mild and clear today.', citations: [CITATION] },
    ],
    stop_reason,
    stop_sequence: null,
    usage: { ...USAGE_END },
  }
}

/** The stream as `[event, data]` pairs, each `data` the JSON text it arrives as. */
export function web_search_sse_events(stop_reason = 'end_turn'): ReadonlyArray<readonly [string, string]> {
  return [
    ['message_start', JSON.stringify({ type: 'message_start', message: { id: 'msg_01G...', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: USAGE_START } })],
    ['content_block_start', '{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I\'ll check"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" the current weather in New York City for you"}}'],
    ['ping', '{"type": "ping"}'],
    ['content_block_delta', '{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"."}}'],
    ['content_block_stop', '{"type":"content_block_stop","index":0}'],
    ['content_block_start', '{"type":"content_block_start","index":1,"content_block":{"type":"server_tool_use","id":"srvtoolu_014hJH82Qum7Td6UV8gDXThB","name":"web_search","input":{}}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\":"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" \\"weather"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":" NY"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"C to"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"day\\"}"}}'],
    ['content_block_stop', '{"type":"content_block_stop","index":1 }'],
    ['content_block_start', JSON.stringify({ type: 'content_block_start', index: 2, content_block: { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_014hJH82Qum7Td6UV8gDXThB', content: [RESULT] } })],
    ['content_block_stop', '{"type":"content_block_stop","index":2}'],
    ['content_block_start', '{"type":"content_block_start","index":3,"content_block":{"type":"text","text":""}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"Here\'s the current weather information for New York"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":" City:\\n\\n# Weather"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":" in New York City"}}'],
    ['content_block_delta', '{"type":"content_block_delta","index":3,"delta":{"type":"text_delta","text":"\\n\\n"}}'],
    ['content_block_stop', '{"type":"content_block_stop","index":3}'],
    // The added cited block, which the docs' example leaves out.
    ['content_block_start', '{"type":"content_block_start","index":4,"content_block":{"type":"text","text":"","citations":[]}}'],
    ['content_block_delta', JSON.stringify({ type: 'content_block_delta', index: 4, delta: { type: 'citations_delta', citation: CITATION } })],
    ['content_block_delta', '{"type":"content_block_delta","index":4,"delta":{"type":"text_delta","text":"It is mild and clear today."}}'],
    ['content_block_stop', '{"type":"content_block_stop","index":4}'],
    ['message_delta', JSON.stringify({ type: 'message_delta', delta: { stop_reason, stop_sequence: null }, usage: USAGE_END })],
    ['message_stop', '{"type":"message_stop"}'],
  ]
}

/** Serve the stream as a `text/event-stream` body, in slices the decoder has to buffer across. */
export function web_search_sse_response(stop_reason = 'end_turn'): Response {
  const body = web_search_sse_events(stop_reason)
    .map(([event, data]) => `event: ${event}\ndata: ${data}\n\n`)
    .join('')
  const bytes = new TextEncoder().encode(body)
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 23) controller.enqueue(bytes.slice(i, i + 23))
      controller.close()
    },
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}
