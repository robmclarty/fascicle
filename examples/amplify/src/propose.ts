/**
 * Propose step: ask Opus for one new candidate, structured as JSON.
 *
 * The model returns `{ rationale, content }`. The schema is enforced via
 * fascicle's Zod-based `model_call`; if the model produces malformed
 * output, fascicle retries the schema repair logic up to its default
 * cap, after which the propose step throws and the harness records a
 * "no_improvement" lesson for that proposer.
 */

import { model_call, type Engine, type Step } from '@repo/fascicle';
import { z } from 'zod';

import { propose_prompt, SYSTEM_PROMPT, type ProposePromptArgs } from './prompts.js';
import type { CandidateSpec } from './types.js';

const PROPOSAL_SCHEMA = z.object({
  rationale: z.string().min(1),
  content: z.string().min(1),
});

type ProposalShape = z.infer<typeof PROPOSAL_SCHEMA>;

export type ProposeArgs = ProposePromptArgs & {
  readonly engine: Engine;
};

export function build_propose_step(args: ProposeArgs): Step<undefined, CandidateSpec> {
  const ask = model_call({
    engine: args.engine,
    system: SYSTEM_PROMPT,
    schema: PROPOSAL_SCHEMA,
    id: `propose:${args.proposer_id}`,
  });

  const prompt = propose_prompt(args);
  const proposer_id = args.proposer_id;

  return {
    id: `propose_${proposer_id}`,
    kind: 'step',
    run: async (_input, ctx) => {
      const result = await ask.run(prompt, ctx);
      const data: ProposalShape = result.content;
      return {
        proposer_id,
        rationale: data.rationale,
        content: data.content,
      };
    },
  };
}
