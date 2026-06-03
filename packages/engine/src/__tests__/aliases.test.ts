import { describe, expect, it } from 'vitest'
import { MODEL_FAMILIES, resolve_model } from '../aliases.js'
import { model_family_unavailable_error } from '../errors.js'
import type { AliasTable } from '../types.js'

const NO_ALIASES: AliasTable = {}
const ctx = { families: MODEL_FAMILIES, aliases: NO_ALIASES }

describe('MODEL_FAMILIES', () => {
  it('is frozen', () => {
    expect(Object.isFrozen(MODEL_FAMILIES)).toBe(true)
  })

  it('carries the bare family token for the claude_cli transport', () => {
    expect(MODEL_FAMILIES['opus']?.['claude_cli']).toBe('opus')
    expect(MODEL_FAMILIES['sonnet']?.['claude_cli']).toBe('sonnet')
    expect(MODEL_FAMILIES['haiku']?.['claude_cli']).toBe('haiku')
  })

  it('carries concrete vendor ids for the anthropic api transport', () => {
    expect(MODEL_FAMILIES['opus']?.['anthropic']).toBe('claude-opus-4-8')
    expect(MODEL_FAMILIES['sonnet']?.['anthropic']).toBe('claude-sonnet-4-6')
  })
})

describe('resolve_model — family + provider', () => {
  it('resolves a family to the latest id for the chosen provider', () => {
    expect(resolve_model('opus', 'claude_cli', ctx)).toEqual({
      provider: 'claude_cli',
      model_id: 'opus',
    })
    expect(resolve_model('opus', 'anthropic', ctx)).toEqual({
      provider: 'anthropic',
      model_id: 'claude-opus-4-8',
    })
    expect(resolve_model('opus', 'openrouter', ctx)).toEqual({
      provider: 'openrouter',
      model_id: 'anthropic/claude-opus-4.8',
    })
  })

  it('throws model_family_unavailable_error when the family has no entry for the provider', () => {
    try {
      resolve_model('opus', 'openai', ctx)
      expect.unreachable('expected throw')
    } catch (err) {
      expect(err).toBeInstanceOf(model_family_unavailable_error)
      const msg = (err as Error).message
      expect(msg).toContain('opus')
      expect(msg).toContain('openai')
      expect(msg).toContain('anthropic')
    }
  })
})

describe('resolve_model — specific vendor ids', () => {
  it('passes a non-family id straight through to the chosen provider', () => {
    expect(resolve_model('claude-opus-4-8', 'anthropic', ctx)).toEqual({
      provider: 'anthropic',
      model_id: 'claude-opus-4-8',
    })
    expect(resolve_model('claude-opus-4-8', 'claude_cli', ctx)).toEqual({
      provider: 'claude_cli',
      model_id: 'claude-opus-4-8',
    })
  })
})

describe('resolve_model — colon form', () => {
  it('splits provider:model on the first colon and overrides the provider arg', () => {
    expect(resolve_model('claude_cli:claude-opus-4-8', 'anthropic', ctx)).toEqual({
      provider: 'claude_cli',
      model_id: 'claude-opus-4-8',
    })
    expect(resolve_model('openrouter:anthropic/claude-sonnet-4.5', 'anthropic', ctx)).toEqual({
      provider: 'openrouter',
      model_id: 'anthropic/claude-sonnet-4.5',
    })
    expect(resolve_model('ollama:gemma3:27b', 'anthropic', ctx)).toEqual({
      provider: 'ollama',
      model_id: 'gemma3:27b',
    })
  })

  it('treats an unknown provider prefix as a literal id (permissive pass-through)', () => {
    expect(resolve_model('unknown-provider:foo', 'anthropic', ctx)).toEqual({
      provider: 'anthropic',
      model_id: 'unknown-provider:foo',
    })
  })
})

describe('resolve_model — user aliases', () => {
  it('a registered alias wins over the family catalog and pins both axes', () => {
    const aliases: AliasTable = {
      opus: { provider: 'openai', model_id: 'gpt-4o' },
    }
    expect(resolve_model('opus', 'claude_cli', { families: MODEL_FAMILIES, aliases })).toEqual({
      provider: 'openai',
      model_id: 'gpt-4o',
    })
  })
})
