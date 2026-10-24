/**
 * The engine contract the canned doubles share.
 *
 * make_stub_engine's tests check that a schema failure throws and names the
 * prefix; these pin what the thrown error carries, since a caller's test
 * asserts on it: issues normalized the way the real engine normalizes them
 * (bare keys, no path key when the vendor gave none), one dotted
 * `path: message` per issue in the message, and the content as wire text.
 * A hand-built Standard Schema supplies the issue shapes zod never produces,
 * such as `{ key }` path segments.
 */

import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { aborted_error, schema_validation_error } from '#engine'
import type { ToolSchema } from '#schema'
import { throw_if_aborted, validate_canned } from '../canned.js'

type VendorIssue = {
  readonly message: string
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>
}

/**
 * A validate-only Standard Schema that rejects every value with `issues`.
 * validate_canned never asks for JSON Schema, so the missing half is cast away.
 */
function rejecting(issues: ReadonlyArray<VendorIssue>): ToolSchema {
  return { '~standard': { version: 1, vendor: 'test', validate: () => ({ issues }) } } as unknown as ToolSchema
}

/** The error `validate_canned` rejects with, or a failure when it resolves. */
async function failure_of(schema: ToolSchema, content: unknown): Promise<schema_validation_error> {
  const err: unknown = await validate_canned(schema, content, 'stub reply').then(
    () => undefined,
    (e: unknown) => e,
  )
  if (!(err instanceof schema_validation_error)) throw new Error('expected a schema_validation_error')
  return err
}

describe('throw_if_aborted', () => {
  it('passes a missing or live signal', () => {
    expect(() => {
      throw_if_aborted(undefined)
    }).not.toThrow()
    expect(() => {
      throw_if_aborted(new AbortController().signal)
    }).not.toThrow()
  })

  it('throws the engine aborted_error carrying the signal reason', () => {
    const controller = new AbortController()
    controller.abort('user cancelled')
    let caught: unknown
    try {
      throw_if_aborted(controller.signal)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(aborted_error)
    if (!(caught instanceof aborted_error)) throw new Error('unreachable')
    expect(caught.message).toBe('aborted')
    expect(caught.reason).toBe('user cancelled')
  })
})

describe('validate_canned', () => {
  it('returns the content untouched when the call has no schema', async () => {
    const content = { any: 'shape' }
    await expect(validate_canned(undefined, content, 'stub reply')).resolves.toBe(content)
  })

  it('returns the schema output, not the raw content, when it passes', async () => {
    const schema = z.object({ n: z.string().transform(Number) })
    await expect(validate_canned(schema, { n: '7' }, 'stub reply')).resolves.toStrictEqual({ n: 7 })
  })

  it('renders one dotted path: message per issue, joined by semicolons', async () => {
    const err = await failure_of(
      rejecting([
        { message: 'required', path: ['name'] },
        { message: 'too small', path: ['items', 0, 'qty'] },
        { message: 'not an object', path: [] },
        { message: 'not allowed' },
      ]),
      {},
    )
    expect(err.message).toBe(
      "stub reply failed the caller's schema: name: required; items.0.qty: too small; not an object; not allowed",
    )
  })

  it('normalizes key-wrapped path segments to bare keys and omits an absent path', async () => {
    const err = await failure_of(
      rejecting([
        { message: 'bad city', path: [{ key: 'address' }, 'city'] },
        { message: 'bad row', path: [{ key: 'rows' }, { key: 2 }] },
        { message: 'whole value' },
      ]),
      {},
    )
    expect(err.schema_issues).toStrictEqual([
      { message: 'bad city', path: ['address', 'city'] },
      { message: 'bad row', path: ['rows', 2] },
      { message: 'whole value' },
    ])
    expect(err.message).toBe(
      "stub reply failed the caller's schema: address.city: bad city; rows.2: bad row; whole value",
    )
  })

  it('carries the content as the text a provider would have sent', async () => {
    const schema = rejecting([{ message: 'no' }])
    expect((await failure_of(schema, 'plain text')).raw_text).toBe('plain text')
    expect((await failure_of(schema, { a: [1] })).raw_text).toBe('{"a":[1]}')
    expect((await failure_of(schema, undefined)).raw_text).toBe('')
  })
})
