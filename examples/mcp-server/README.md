# mcp-server

A minimal [Model Context Protocol](https://modelcontextprotocol.io) server over
stdio, plus a tiny client that smoke-tests it. Standalone: it does not import
fascicle, and needs no API key, Docker, or Ollama.

## What it exposes

Three tools and one resource template, registered on an `McpServer`:

| Surface              | Kind     | Behavior                                         |
| -------------------- | -------- | ------------------------------------------------ |
| `add`                | tool     | Adds two numbers and returns the sum.            |
| `reverse_text`       | tool     | Returns the input string reversed.               |
| `word_count`         | tool     | Returns `{ words, chars }` for the input string. |
| `greeting://{name}`  | resource | A personalized `Hello, {name}!` greeting.        |

## Run

```bash
# Serve over stdio (for an MCP host like Claude Code or Claude Desktop).
pnpm --filter @repo/example-mcp-server start

# Smoke test: spawn the server, list tools, call each one, assert results.
pnpm --filter @repo/example-mcp-server smoke
```

The smoke client checks every tool and the greeting resource against expected
values and exits non-zero if any assertion fails.

## Wire into Claude Code

Add to `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "example": {
      "command": "pnpm",
      "args": ["--filter", "@repo/example-mcp-server", "start"]
    }
  }
}
```
