/**
 * End-to-end flow tests through the real `run()` with a stub engine and the
 * real docs corpus. Canned responses validate through the real schema, so a
 * schema change breaks any test shipping stale fixture data.
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { run } from 'fascicle'
import { describe, expect, it } from 'vitest'

import { make_stub_engine } from '../engine.js'
import { build_flow } from '../flow.js'
import { make_docs_retriever } from '../services/retriever.js'

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs')

function build(content: unknown) {
  const engine = make_stub_engine([
    { match_system_prefix: 'docs-concierge/answerer', content },
  ])
  return build_flow(engine, { answerer: 'stub' }, { retriever: make_docs_retriever(DOCS), k: 4 })
}

describe('docs-concierge flow', () => {
  it('answers a covered question with resolved citations', async () => {
    const outcome = await run(
      build({
        abstain: false,
        confidence: 'high',
        answer: 'Only workspace admins can delete a project. [1]',
        citations: [1],
      }),
      { question: 'Who can delete a project?' },
    )
    expect(outcome.kind).toBe('answer')
    if (outcome.kind === 'answer') {
      expect(outcome.text).toBe('Only workspace admins can delete a project.')
      expect(outcome.citations[0]?.path).toBe('permissions.md')
    }
  })

  it('abstains when the model abstains', async () => {
    const outcome = await run(
      build({ abstain: true, confidence: 'low', answer: '', citations: [] }),
      { question: 'Who can delete a project?' },
    )
    expect(outcome).toEqual({ kind: 'abstain', reason: 'model_abstained' })
  })

  it('abstains when the model cites nothing that was retrieved', async () => {
    const outcome = await run(
      build({ abstain: false, confidence: 'high', answer: 'Made up.', citations: [99] }),
      { question: 'Who can delete a project?' },
    )
    expect(outcome).toEqual({ kind: 'abstain', reason: 'invalid_citations' })
  })

  it('abstains with no_passages when retrieval finds nothing', async () => {
    const outcome = await run(
      build({ abstain: false, confidence: 'high', answer: 'Anything.', citations: [1] }),
      { question: 'zxqv' },
    )
    expect(outcome).toEqual({ kind: 'abstain', reason: 'no_passages' })
  })
})
