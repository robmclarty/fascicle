/**
 * Reasoning-effort translation tests for the claude_cli provider.
 *
 * Asserts:
 *   - `effort_env_for_claude_cli` maps every non-`none` EffortLevel to
 *     `CLAUDE_CODE_EFFORT_LEVEL` with the matching string value.
 *   - `none` and `undefined` produce an empty record (no env var set —
 *     the inherited environment wins).
 *   - The provider advertises `'reasoning'` capability.
 */

import { describe, expect, it } from 'vitest';
import {
  create_claude_cli_adapter,
  effort_env_for_claude_cli,
} from '../../../src/providers/claude_cli/index.js';
import type { EffortLevel } from '../../../src/types.js';

describe('effort_env_for_claude_cli', () => {
  it('returns an empty record for none', () => {
    expect(effort_env_for_claude_cli('none')).toEqual({});
  });

  it('returns an empty record for undefined', () => {
    expect(effort_env_for_claude_cli(undefined)).toEqual({});
  });

  it('maps every non-none EffortLevel to CLAUDE_CODE_EFFORT_LEVEL verbatim', () => {
    const cases: ReadonlyArray<Exclude<EffortLevel, 'none'>> = [
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ];
    for (const effort of cases) {
      expect(effort_env_for_claude_cli(effort)).toEqual({
        CLAUDE_CODE_EFFORT_LEVEL: effort,
      });
    }
  });
});

describe('create_claude_cli_adapter', () => {
  it('advertises reasoning capability', () => {
    const adapter = create_claude_cli_adapter({ auth_mode: 'oauth' });
    expect(adapter.supports('reasoning')).toBe(true);
  });

  it('still advertises text/tools/schema/streaming', () => {
    const adapter = create_claude_cli_adapter({ auth_mode: 'oauth' });
    for (const cap of ['text', 'tools', 'schema', 'streaming'] as const) {
      expect(adapter.supports(cap)).toBe(true);
    }
  });
});
