import { describe as vdescribe, expect, it } from 'vitest'
import { assert_valid_step_id, is_valid_step_id, suggest_step_id } from '../step_id.js'

vdescribe('is_valid_step_id', () => {
  it.each([
    'fetch_manifest',
    'a',
    '_private',
    '$dollar',
    'camelCase',
    'with9digits',
    'héllo',
    'step_12',
    'model_call_1bd1d77f_32',
  ])('accepts %j', (id) => {
    expect(is_valid_step_id(id)).toBe(true)
  })

  it.each([
    ['', 'the empty string'],
    ['this is my id', 'spaces'],
    ['my-id', 'a hyphen'],
    ['my.id', 'a dot'],
    ['model_call:abc:1', 'colons'],
    ['1st_step', 'a leading digit'],
    ['user@example', 'an at sign'],
    ['a😀b', 'an astral character'],
  ])('rejects %j (%s)', (id) => {
    expect(is_valid_step_id(id)).toBe(false)
  })
})

vdescribe('suggest_step_id', () => {
  it('swaps illegal characters for underscores', () => {
    expect(suggest_step_id('this is my id')).toBe('this_is_my_id')
    expect(suggest_step_id('user@example')).toBe('user_example')
  })

  it('prefixes an underscore when the swap still leaves a bad leading character', () => {
    expect(suggest_step_id('1st step')).toBe('_1st_step')
    expect(suggest_step_id('')).toBe('_')
  })

  it('leaves an already-valid id alone', () => {
    expect(suggest_step_id('fetch_manifest')).toBe('fetch_manifest')
  })

  it('always returns something valid', () => {
    for (const raw of ['1st step', '', 'a😀b', '...', 'my-id']) {
      expect(is_valid_step_id(suggest_step_id(raw))).toBe(true)
    }
  })

  it('is not applied on the caller behalf, so distinct names still collide', () => {
    // The reason nothing normalizes: three different names, one suggestion.
    expect(suggest_step_id('my-id')).toBe('my_id')
    expect(suggest_step_id('my.id')).toBe('my_id')
    expect(suggest_step_id('my id')).toBe('my_id')
  })
})

vdescribe('assert_valid_step_id', () => {
  it('passes a valid id through silently', () => {
    expect(() => assert_valid_step_id('ok_id', 'step id', 'do the thing')).not.toThrow()
  })

  it('names the subject, the offending value, the suggestion, and the remedy', () => {
    expect(() => assert_valid_step_id('my id', 'step id', 'put the label in meta.name')).toThrow(
      'step id "my id" is not a valid identifier: ids are read back as property names, so use my_id and put the label in meta.name',
    )
  })

  it('throws a TypeError', () => {
    expect(() => assert_valid_step_id('my id', 'step id', 'x')).toThrow(TypeError)
  })
})
