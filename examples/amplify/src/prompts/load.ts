/**
 * Minimal markdown prompt loader: frontmatter (`key: value` lines between
 * `---` fences) plus body. The body is the system prompt; frontmatter may
 * carry a per-role `model` override. Deliberately tiny, per the blueprint.
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export type LoadedPrompt = {
  readonly name?: string
  readonly model?: string
  readonly body: string
}

export function load_prompt(path: URL): LoadedPrompt {
  const text = readFileSync(fileURLToPath(path), 'utf8')
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/)
  if (!match) return { body: text.trim() }
  const out: { name?: string; model?: string } = {}
  for (const raw of (match[1] ?? '').split(/\r?\n/)) {
    const idx = raw.indexOf(':')
    if (idx === -1) continue
    const key = raw.slice(0, idx).trim()
    const value = raw.slice(idx + 1).trim()
    if (key === 'name') out.name = value
    if (key === 'model') out.model = value
  }
  return { ...out, body: text.slice(match[0].length).trim() }
}
