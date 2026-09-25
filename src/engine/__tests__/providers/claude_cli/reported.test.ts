/**
 * claude_cli_reported: the typed read of `provider_reported['claude_cli']`.
 */

import { describe, expect, it } from 'vitest'
import { claude_cli_reported } from '../../../providers/claude_cli/reported.js'

describe('claude_cli_reported', () => {
  it('reads session_id and duration_ms off a well-formed entry', () => {
    const source = { provider_reported: { claude_cli: { session_id: 's', duration_ms: 5 } } }
    expect(claude_cli_reported(source)).toEqual({ session_id: 's', duration_ms: 5 })
  })

  it('carries duration_api_ms through only when it is a number', () => {
    const with_api = {
      provider_reported: { claude_cli: { session_id: 's', duration_ms: 5, duration_api_ms: 3 } },
    }
    expect(claude_cli_reported(with_api)).toEqual({
      session_id: 's',
      duration_ms: 5,
      duration_api_ms: 3,
    })
    const bad_api = {
      provider_reported: { claude_cli: { session_id: 's', duration_ms: 5, duration_api_ms: '3' } },
    }
    expect(claude_cli_reported(bad_api)).toEqual({ session_id: 's', duration_ms: 5 })
  })

  it('returns undefined without provider_reported or a claude_cli entry', () => {
    expect(claude_cli_reported({})).toBeUndefined()
    expect(claude_cli_reported({ provider_reported: { bedrock: {} } })).toBeUndefined()
  })

  it('returns undefined when the entry is not an object', () => {
    expect(claude_cli_reported({ provider_reported: { claude_cli: null } })).toBeUndefined()
    expect(claude_cli_reported({ provider_reported: { claude_cli: 'x' } })).toBeUndefined()
  })

  it('returns undefined when session_id or duration_ms has the wrong type', () => {
    expect(
      claude_cli_reported({ provider_reported: { claude_cli: { session_id: 1, duration_ms: 5 } } }),
    ).toBeUndefined()
    expect(
      claude_cli_reported({ provider_reported: { claude_cli: { session_id: 's', duration_ms: '5' } } }),
    ).toBeUndefined()
  })
})
