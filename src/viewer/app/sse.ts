/**
 * The browser end of `/api/events`.
 *
 * The server frames every trajectory line as an SSE `trajectory` event, so the
 * client's whole job is to decode one JSON object per frame and hand it on.
 * The `EventSource` constructor arrives as an argument rather than being
 * reached through the global, which keeps this module free of the DOM lib and
 * lets the node test suite drive it with a fake stream instead of a browser.
 */

/**
 * A decoded trajectory frame: the whole parsed event, verbatim.
 *
 * Only `kind` is guaranteed by the wire contract. Everything else stays
 * untyped surplus on purpose: the fold reads each field permissively at the
 * point of use (C7), so narrowing here would only duplicate its guards.
 */
export type ViewerFrame = Readonly<Record<string, unknown>> & {
  readonly kind: string
}

/** The slice of `EventSource` this module uses, so a fake can stand in for it. */
export type EventSourceLike = {
  readonly addEventListener: (type: string, listener: (event: { data: string }) => void) => void
  readonly close: () => void
}

export type ConnectOptions = {
  readonly url: string
  readonly open: (url: string) => EventSourceLike
  readonly on_frame: (frame: ViewerFrame) => void
  readonly on_status: (status: SseStatus) => void
}

export type SseStatus = 'connecting' | 'live' | 'offline'

export type SseConnection = {
  readonly close: () => void
}

/**
 * Decodes one SSE `data:` payload into a frame, or `null` when it is not one.
 *
 * Permissive by contract (C7): a frame whose kind this build has never heard
 * of still parses and still counts, because the wire is allowed to grow new
 * kinds without the canvas being rebuilt. Only structurally broken input,
 * which no producer should ever send, is dropped.
 */
export function parse_frame(data: string): ViewerFrame | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(data)
  } catch {
    return null
  }
  return is_frame(parsed) ? parsed : null
}

/** The wire gate: a non-array object carrying a string `kind`. */
function is_frame(value: unknown): value is ViewerFrame {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return typeof (value as { kind?: unknown }).kind === 'string'
}

/**
 * Opens the SSE stream and reports frames and connection status.
 *
 * The server replays whatever the ring buffer holds before following live, so
 * a late-arriving browser sees the same frames in the same order as one that
 * was open from the first event. `close` is idempotent from the caller's side
 * because `EventSource.close` is.
 */
export function connect_events(options: ConnectOptions): SseConnection {
  const { url, open, on_frame, on_status } = options
  on_status('connecting')

  const source = open(url)
  source.addEventListener('open', () => {
    on_status('live')
  })
  source.addEventListener('trajectory', (event) => {
    const frame = parse_frame(event.data)
    if (frame !== null) on_frame(frame)
  })
  // The server writes a `close` frame on shutdown and the browser raises
  // `error` on a dropped socket; both mean the same thing to the header.
  source.addEventListener('close', () => {
    on_status('offline')
  })
  source.addEventListener('error', () => {
    on_status('offline')
  })

  return { close: () => { source.close() } }
}
