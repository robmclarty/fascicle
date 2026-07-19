import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { make_docs_retriever } from '../services/retriever.js'

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')

describe('make_docs_retriever', () => {
  it('ranks the section that actually answers the question first', async () => {
    const passages = await make_docs_retriever(DOCS).search('Who can delete a project?', 4)
    expect(passages.length).toBeGreaterThan(0)
    expect(passages[0]?.path).toBe('permissions.md')
    expect(passages[0]?.heading).toBe('Deleting a project')
  })

  it('returns at most k passages, all with positive scores', async () => {
    const passages = await make_docs_retriever(DOCS).search('project workspace export', 2)
    expect(passages.length).toBeLessThanOrEqual(2)
    expect(passages.every((p) => p.score > 0)).toBe(true)
  })

  it('returns nothing for a query with no matching terms', async () => {
    const passages = await make_docs_retriever(DOCS).search('zxqv', 4)
    expect(passages).toEqual([])
  })
})
