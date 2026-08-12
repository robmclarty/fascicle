import { describe, expect, it } from 'vitest'
import { z } from 'zod'

import { format_schema_issues, validate_schema } from '#schema'
import type { AnySchema, SchemaIssue } from '#schema'

const user_schema = z.object({ name: z.string(), age: z.number().int() })

/**
 * A minimal vendor whose `validate` answers synchronously, standing in for the
 * half of the ecosystem that does not return promises.
 */
const sync_vendor: AnySchema<string> = {
  '~standard': {
    version: 1,
    vendor: 'sync-vendor',
    validate: (value: unknown) =>
      typeof value === 'string'
        ? { value }
        : { issues: [{ message: 'expected a string' }] },
  },
}

/**
 * The same vendor, returning a promise instead, which the spec equally permits.
 */
const async_vendor: AnySchema<string> = {
  '~standard': {
    version: 1,
    vendor: 'async-vendor',
    validate: async (value: unknown) =>
      typeof value === 'string'
        ? { value }
        : { issues: [{ message: 'expected a string' }] },
  },
}

/**
 * A vendor reporting paths as `{ key }` wrappers rather than bare keys, the
 * other shape the spec allows.
 */
const wrapped_path_vendor: AnySchema<never> = {
  '~standard': {
    version: 1,
    vendor: 'wrapped-path-vendor',
    validate: () => ({
      issues: [{ message: 'expected a string', path: [{ key: 'address' }, { key: 'city' }] }],
    }),
  },
}

describe('validate_schema', () => {
  it('returns the validated value for a synchronous vendor', async () => {
    await expect(validate_schema(sync_vendor, 'ok')).resolves.toEqual({
      ok: true,
      value: 'ok',
    })
  })

  it('returns the validated value for a promise-returning vendor', async () => {
    await expect(validate_schema(async_vendor, 'ok')).resolves.toEqual({
      ok: true,
      value: 'ok',
    })
  })

  it('reports issues for a synchronous vendor', async () => {
    await expect(validate_schema(sync_vendor, 42)).resolves.toEqual({
      ok: false,
      issues: [{ message: 'expected a string' }],
    })
  })

  it('reports issues for a promise-returning vendor', async () => {
    await expect(validate_schema(async_vendor, 42)).resolves.toEqual({
      ok: false,
      issues: [{ message: 'expected a string' }],
    })
  })

  it('normalizes wrapped path segments to bare keys', async () => {
    const outcome = await validate_schema(wrapped_path_vendor, {})
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.issues).toEqual([
      { message: 'expected a string', path: ['address', 'city'] },
    ])
  })

  it('omits the path entirely when the vendor reports none', async () => {
    const outcome = await validate_schema(sync_vendor, 42)
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.issues[0]).not.toHaveProperty('path')
  })

  it('validates a zod schema through the neutral interface', async () => {
    await expect(validate_schema(user_schema, { name: 'ada', age: 36 })).resolves.toEqual({
      ok: true,
      value: { name: 'ada', age: 36 },
    })
  })

  it('surfaces a zod failure as issues carrying the field path', async () => {
    const outcome = await validate_schema(user_schema, { name: 'ada', age: 'old' })
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.issues).toHaveLength(1)
    expect(outcome.issues[0]?.path).toEqual(['age'])
    expect(outcome.issues[0]?.message).toContain('expected number')
  })
})

describe('format_schema_issues', () => {
  it('prefixes the message with a dotted path', () => {
    const issues: SchemaIssue[] = [{ message: 'expected a string', path: ['address', 'city'] }]
    expect(format_schema_issues(issues)).toBe('address.city: expected a string')
  })

  it('dots array indices rather than bracketing them', () => {
    const issues: SchemaIssue[] = [{ message: 'expected a string', path: ['items', 0, 'name'] }]
    expect(format_schema_issues(issues)).toBe('items.0.name: expected a string')
  })

  it('renders a pathless issue as the bare message', () => {
    expect(format_schema_issues([{ message: 'expected an object' }])).toBe('expected an object')
  })

  it('renders an empty path as the bare message', () => {
    expect(format_schema_issues([{ message: 'expected an object', path: [] }])).toBe(
      'expected an object',
    )
  })

  it('joins several issues with semicolons', () => {
    const issues: SchemaIssue[] = [
      { message: 'expected a string', path: ['name'] },
      { message: 'expected a number', path: ['age'] },
    ]
    expect(format_schema_issues(issues)).toBe(
      'name: expected a string; age: expected a number',
    )
  })

  it('falls back to a placeholder when a vendor reports no issues at all', () => {
    expect(format_schema_issues([])).toBe('unknown schema issue')
  })

  it('stringifies a symbol path segment rather than throwing', () => {
    const issues: SchemaIssue[] = [{ message: 'expected a string', path: [Symbol('secret')] }]
    expect(format_schema_issues(issues)).toBe('Symbol(secret): expected a string')
  })
})
