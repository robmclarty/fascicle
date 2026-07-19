/**
 * A deliberately small retriever over a directory of markdown files: split
 * each file into passages by `##` heading, score by content-word overlap with
 * the query, return the top k. It exists so the example runs end to end with
 * no external services; the `Retriever` port is the seam where a real vector
 * store, search API, or MCP server would plug in without touching the flow.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

import type { Passage } from '../types.js'

export type Retriever = {
  readonly search: (query: string, k: number) => Promise<ReadonlyArray<Passage>>
}

const STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'can', 'you', 'your', 'how', 'who', 'what',
  'when', 'where', 'why', 'does', 'this', 'that', 'with', 'from', 'into',
  'has', 'have', 'will', 'not', 'all', 'any', 'its',
])

function tokens(text: string): ReadonlyArray<string> {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
}

/** Occurrence-weighted overlap: how often the query's terms appear in the passage. */
function overlap_score(query: ReadonlySet<string>, passage: ReadonlyArray<string>): number {
  let score = 0
  for (const t of passage) if (query.has(t)) score += 1
  return score
}

type Section = { readonly heading: string; readonly content: string }

function split_sections(body: string, fallback_heading: string): ReadonlyArray<Section> {
  const parts = body.split(/^## /m)
  const sections: Section[] = []
  const preamble = parts[0]?.trim() ?? ''
  if (preamble.length > 0 && parts.length === 1) {
    sections.push({ heading: fallback_heading, content: preamble })
  }
  for (const part of parts.slice(1)) {
    const newline = part.indexOf('\n')
    const heading = newline === -1 ? part.trim() : part.slice(0, newline).trim()
    const content = newline === -1 ? '' : part.slice(newline + 1).trim()
    if (content.length > 0) sections.push({ heading, content })
  }
  return sections
}

export function make_docs_retriever(dir: string): Retriever {
  return {
    search: async (query, k) => {
      const query_tokens = new Set(tokens(query))
      const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).toSorted()
      const passages: Passage[] = []
      for (const file of files) {
        const body = await readFile(join(dir, file), 'utf8')
        const title = body.match(/^# (.+)$/m)?.[1] ?? file
        for (const section of split_sections(body, title)) {
          const score = overlap_score(query_tokens, tokens(`${section.heading}\n${section.content}`))
          if (score > 0) {
            passages.push({ path: file, heading: section.heading, content: section.content, score })
          }
        }
      }
      return passages.toSorted((a, b) => b.score - a.score).slice(0, k)
    },
  }
}
