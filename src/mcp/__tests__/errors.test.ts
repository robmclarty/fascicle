import { describe, expect, it } from 'vitest'
import { mcp_error, mcp_sdk_missing_error } from '../errors.js'

describe('mcp errors', () => {
  it('mcp_sdk_missing_error carries install guidance by default', () => {
    const err = new mcp_sdk_missing_error()
    expect(err.name).toBe('mcp_sdk_missing_error')
    expect(err.kind).toBe('mcp_sdk_missing_error')
    expect(err.message).toContain('pnpm add @modelcontextprotocol/sdk')
  })

  it('mcp_error carries an optional tool_name', () => {
    expect(new mcp_error('boom').tool_name).toBeUndefined()
    const named = new mcp_error('boom', { tool_name: 'do_thing' })
    expect(named.tool_name).toBe('do_thing')
    expect(named.name).toBe('mcp_error')
    expect(named.kind).toBe('mcp_error')
  })
})
