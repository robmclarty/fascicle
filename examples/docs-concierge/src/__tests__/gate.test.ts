import { describe, expect, it } from 'vitest'

import { gate, strip_citation_markers } from '../gate.js'
import type { Assessment, Passage } from '../types.js'

const PASSAGES: ReadonlyArray<Passage> = [
  { path: 'permissions.md', heading: 'Deleting a project', content: 'Only admins.', score: 3 },
  { path: 'exports.md', heading: 'Data retention', content: '30 days.', score: 1 },
]

function assessment(overrides: Partial<Assessment> = {}): Assessment {
  return {
    abstain: false,
    confidence: 'high',
    answer: 'Only workspace admins can delete a project.',
    citations: [1],
    ...overrides,
  }
}

describe('gate', () => {
  it('passes a confident, cited answer through with resolved citations', () => {
    const outcome = gate(assessment(), PASSAGES)
    expect(outcome).toEqual({
      kind: 'answer',
      text: 'Only workspace admins can delete a project.',
      confidence: 'high',
      citations: [{ path: 'permissions.md', heading: 'Deleting a project' }],
    })
  })

  it('abstains when the model abstains', () => {
    expect(gate(assessment({ abstain: true }), PASSAGES)).toEqual({
      kind: 'abstain',
      reason: 'model_abstained',
    })
  })

  it('abstains when nothing was retrieved', () => {
    expect(gate(assessment(), [])).toEqual({ kind: 'abstain', reason: 'no_passages' })
  })

  it('abstains below the confidence threshold', () => {
    expect(gate(assessment({ confidence: 'low' }), PASSAGES)).toEqual({
      kind: 'abstain',
      reason: 'low_confidence',
    })
    expect(gate(assessment({ confidence: 'low' }), PASSAGES, { min_confidence: 'low' }).kind).toBe(
      'answer',
    )
  })

  it('abstains when no citation resolves to a retrieved passage', () => {
    expect(gate(assessment({ citations: [99] }), PASSAGES)).toEqual({
      kind: 'abstain',
      reason: 'invalid_citations',
    })
  })

  it('drops invalid citation numbers but keeps the valid ones', () => {
    const outcome = gate(assessment({ citations: [99, 2, 2] }), PASSAGES)
    expect(outcome.kind).toBe('answer')
    if (outcome.kind === 'answer') {
      expect(outcome.citations).toEqual([{ path: 'exports.md', heading: 'Data retention' }])
    }
  })

  it('abstains when the answer is empty after stripping markers', () => {
    expect(gate(assessment({ answer: ' [1] ' }), PASSAGES)).toEqual({
      kind: 'abstain',
      reason: 'empty_answer',
    })
  })
})

describe('strip_citation_markers', () => {
  it('removes bare markers but not markdown links', () => {
    expect(strip_citation_markers('Admins only [1], see settings [2, 3].')).toBe(
      'Admins only, see settings.',
    )
    expect(strip_citation_markers('See [the docs](https://example.com).')).toBe(
      'See [the docs](https://example.com).',
    )
  })
})
