import { describe, expect, it } from 'vitest'
import { create_broadcaster } from '../broadcast.js'

describe('create_broadcaster', () => {
  it('emits monotonic ids and stores events in the ring', () => {
    const b = create_broadcaster({ buffer: 10 })
    const a = b.emit({ kind: 'span_start', span_id: 's1', name: 'step' })
    const c = b.emit({ kind: 'span_end', span_id: 's1' })
    expect(a.id).toBe(1)
    expect(c.id).toBe(2)
    const snap = b.snapshot()
    expect(snap.map((e) => e.id)).toEqual([1, 2])
    expect(b.size()).toBe(2)
  })

  it('caps the ring buffer at the configured size, dropping oldest', () => {
    const b = create_broadcaster({ buffer: 3 })
    for (let i = 0; i < 5; i++) b.emit({ kind: 'emit', i })
    const snap = b.snapshot()
    expect(snap.map((e) => e.id)).toEqual([3, 4, 5])
    expect(b.size()).toBe(3)
  })

  it('fans out to every subscriber in registration order', () => {
    const b = create_broadcaster({ buffer: 10 })
    const a: number[] = []
    const c: number[] = []
    b.subscribe((e) => a.push(e.id))
    b.subscribe((e) => c.push(e.id))
    b.emit({ kind: 'emit' })
    b.emit({ kind: 'emit' })
    expect(a).toEqual([1, 2])
    expect(c).toEqual([1, 2])
  })

  it('unsubscribe stops further notifications', () => {
    const b = create_broadcaster({ buffer: 10 })
    const seen: number[] = []
    const off = b.subscribe((e) => seen.push(e.id))
    b.emit({ kind: 'emit' })
    off()
    b.emit({ kind: 'emit' })
    expect(seen).toEqual([1])
  })

  it('throwing subscribers are removed and surfaced via on_subscriber_error, others keep going', () => {
    const errors: unknown[] = []
    const b = create_broadcaster({ buffer: 10, on_subscriber_error: (e) => errors.push(e) })
    const good: number[] = []
    b.subscribe(() => { throw new Error('bad sub') })
    b.subscribe((e) => good.push(e.id))
    b.emit({ kind: 'emit' })
    b.emit({ kind: 'emit' })
    expect(good).toEqual([1, 2])
    expect(errors).toHaveLength(1)
  })

  it('snapshot_after returns only events with id > cursor', () => {
    const b = create_broadcaster({ buffer: 10 })
    b.emit({ kind: 'emit' })
    b.emit({ kind: 'emit' })
    b.emit({ kind: 'emit' })
    const after = b.snapshot_after(2)
    expect(after.map((e) => e.id)).toEqual([3])
  })
})
