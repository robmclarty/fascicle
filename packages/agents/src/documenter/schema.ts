/**
 * Documenter agent: input/output types and Zod output schema.
 */

import { z } from 'zod'

export const documenter_output_schema = z.object({
  doc: z.string(),
  inferred_purpose: z.string(),
})

export type DocumenterStyle = 'tsdoc' | 'jsdoc' | 'markdown'

export type DocumenterTarget =
  | { readonly kind: 'file'; readonly path: string; readonly contents: string }
  | {
      readonly kind: 'symbol'
      readonly name: string
      readonly signature: string
      readonly body?: string
    }

export type DocumenterInput = {
  readonly target: DocumenterTarget
  readonly style?: DocumenterStyle
}

export type DocumenterOutput = z.infer<typeof documenter_output_schema>
