/**
 * In-process pub/sub for trajectory events.
 *
 * One ring buffer of the last N events plus a Set of subscriber callbacks.
 * Both producers (file-tail and HTTP ingest) push into the same broadcaster;
 * SSE writers fan out via subscribe(). Each event gets a monotonic `id` so
 * SSE clients can replay from a known cursor on reconnect.
 *
 * Slow-client backpressure is the subscriber's responsibility — emit() does
 * not await delivery. If a subscriber throws, it is unsubscribed and the
 * `on_subscriber_error` callback fires once with the captured error so the
 * server can log it.
 */

import type { ParsedTrajectoryEvent } from '@repo/core'

export type BroadcastEvent = {
  readonly id: number
  readonly event: ParsedTrajectoryEvent
}

export type Subscriber = (entry: BroadcastEvent) => void

export type Broadcaster = {
  readonly emit: (event: ParsedTrajectoryEvent) => BroadcastEvent
  readonly subscribe: (fn: Subscriber) => () => void
  readonly snapshot: () => readonly BroadcastEvent[]
  readonly snapshot_after: (last_id: number) => readonly BroadcastEvent[]
  readonly size: () => number
}

export type BroadcasterOptions = {
  readonly buffer: number
  readonly on_subscriber_error?: (err: unknown) => void
}

export function create_broadcaster(options: BroadcasterOptions): Broadcaster {
  const max = Math.max(1, options.buffer | 0)
  const ring: BroadcastEvent[] = []
  const subscribers = new Set<Subscriber>()
  let next_id = 1

  const emit = (event: ParsedTrajectoryEvent): BroadcastEvent => {
    const entry: BroadcastEvent = { id: next_id++, event }
    ring.push(entry)
    if (ring.length > max) ring.splice(0, ring.length - max)
    for (const fn of Array.from(subscribers)) {
      try {
        fn(entry)
      } catch (err) {
        subscribers.delete(fn)
        if (options.on_subscriber_error) options.on_subscriber_error(err)
      }
    }
    return entry
  }

  const subscribe = (fn: Subscriber): (() => void) => {
    subscribers.add(fn)
    return () => { subscribers.delete(fn) }
  }

  const snapshot = (): readonly BroadcastEvent[] => [...ring]

  const snapshot_after = (last_id: number): readonly BroadcastEvent[] =>
    ring.filter((e) => e.id > last_id)

  const size = (): number => ring.length

  return { emit, subscribe, snapshot, snapshot_after, size }
}
