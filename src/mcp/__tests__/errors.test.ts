import { describe, expect, it } from 'vitest'
import { mcp_auth_required_error, mcp_error, mcp_sdk_missing_error } from '../errors.js'

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

  it('mcp_auth_required_error names the server, says what to pass, and keeps the cause', () => {
    const cause = new Error('Unauthorized')
    const err = new mcp_auth_required_error('https://example.com/mcp', cause)
    expect(err.name).toBe('mcp_auth_required_error')
    expect(err.kind).toBe('mcp_auth_required_error')
    expect(err.url).toBe('https://example.com/mcp')
    expect(err.cause).toBe(cause)
    expect(err.message).toBe(
      "MCP server at https://example.com/mcp requires authorization (Unauthorized): pass `auth_provider` in the http config with a token the server accepts, or finish an interactive OAuth flow on a transport of your own and pass its client as `transport: 'client'`",
    )
  })

  it('mcp_auth_required_error spells out a cause that is not an Error', () => {
    const err = new mcp_auth_required_error('https://example.com/mcp', 'HTTP 401')
    expect(err.message).toContain('requires authorization (HTTP 401): pass')
    expect(err.cause).toBe('HTTP 401')
  })
})
