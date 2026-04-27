/**
 * Online research step.
 *
 * Runs ONCE at startup against the brief and produces a short bulleted
 * summary of techniques worth trying. The summary is cached to disk and
 * prepended to every subsequent propose prompt — capped at ~500 tokens to
 * avoid context bloat.
 *
 * Two modes:
 *
 *   - `AMPLIFY_RESEARCH=web` (default): allows the Claude Code CLI's
 *     hosted `WebSearch` tool via `provider_options.claude_cli.allowed_tools`.
 *     The model can pull recent techniques from the live web.
 *
 *   - `AMPLIFY_RESEARCH=offline`: skips the web tool. Falls back to the
 *     model's training knowledge. Works offline; staleness is the cost.
 *
 * If the CLI lacks `WebSearch` (older versions) or the call fails for any
 * reason, the step degrades gracefully to offline.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { model_call, type Engine, type RunContext } from '@repo/fascicle';

import { research_prompt, RESEARCH_SYSTEM_PROMPT } from './prompts.js';
import type { Brief } from './types.js';

export type ResearchMode = 'web' | 'offline';

export function pick_mode(): ResearchMode {
  const env_val = process.env['AMPLIFY_RESEARCH'];
  if (env_val === 'offline') return 'offline';
  return 'web';
}

const RESEARCH_MAX_CHARS = 2_000;

function clamp(s: string): string {
  return s.length <= RESEARCH_MAX_CHARS ? s : `${s.slice(0, RESEARCH_MAX_CHARS)}\n…(truncated)`;
}

async function ask_with_web(
  engine: Engine,
  brief: Brief,
  ctx: RunContext,
): Promise<string> {
  const provider_options = {
    claude_cli: {
      allowed_tools: ['WebSearch'],
    },
  };
  const ask = model_call({
    engine,
    system: RESEARCH_SYSTEM_PROMPT,
    effort: 'low',
    provider_options,
    id: 'research_web',
  });
  const result = await ask.run(research_prompt(brief), ctx);
  return clamp(stringify(result.content));
}

async function ask_offline(engine: Engine, brief: Brief, ctx: RunContext): Promise<string> {
  const ask = model_call({
    engine,
    system: RESEARCH_SYSTEM_PROMPT,
    effort: 'low',
    id: 'research_offline',
  });
  const result = await ask.run(research_prompt(brief), ctx);
  return clamp(stringify(result.content));
}

function stringify(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part) {
          const text = (part as { text?: unknown }).text;
          return typeof text === 'string' ? text : '';
        }
        return '';
      })
      .filter((s) => s.length > 0)
      .join('\n');
  }
  return JSON.stringify(content);
}

export async function gather_research(
  engine: Engine,
  brief: Brief,
  ctx: RunContext,
  mode: ResearchMode,
): Promise<string> {
  if (mode === 'offline') {
    return ask_offline(engine, brief, ctx);
  }
  try {
    return await ask_with_web(engine, brief, ctx);
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    ctx.trajectory.record({
      kind: 'amplify.research_web_failed',
      reason: note,
    });
    return ask_offline(engine, brief, ctx);
  }
}

export async function cache_research(run_dir: string, summary: string): Promise<void> {
  await mkdir(run_dir, { recursive: true });
  await writeFile(join(run_dir, 'research.md'), summary, 'utf8');
}
