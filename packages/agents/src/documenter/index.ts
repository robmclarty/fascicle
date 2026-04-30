/**
 * documenter: structured documentation agent.
 *
 * Markdown-defined: the system prompt lives in `./prompt.md`, the output
 * schema in `./schema.ts`. The factory wires them through `define_agent`
 * with a `build_prompt` that flattens the file/symbol target and the
 * requested style into the user message.
 */

import type { Step } from '@repo/core';
import type { Engine } from '@repo/engine';
import { define_agent } from '../define_agent.js';
import {
  documenter_output_schema,
  type DocumenterInput,
  type DocumenterOutput,
} from './schema.js';

export type DocumenterConfig = {
  readonly engine: Engine;
  readonly name?: string;
};

const DEFAULT_STYLE = 'tsdoc';

export function documenter(
  config: DocumenterConfig,
): Step<DocumenterInput, DocumenterOutput> {
  return define_agent<DocumenterInput, DocumenterOutput>({
    md_path: new URL('./prompt.md', import.meta.url),
    schema: documenter_output_schema,
    engine: config.engine,
    ...(config.name !== undefined ? { name: config.name } : {}),
    build_prompt: (input) => {
      const style = input.style ?? DEFAULT_STYLE;
      const target =
        input.target.kind === 'file'
          ? `File: ${input.target.path}\n\n${input.target.contents}`
          : `Symbol: ${input.target.name}\nSignature: ${input.target.signature}${
              input.target.body !== undefined ? `\n\nBody:\n${input.target.body}` : ''
            }`;
      return `Style: ${style}\n\n${target}`;
    },
  });
}
