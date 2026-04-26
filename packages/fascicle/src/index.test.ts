import { describe, expect, it } from 'vitest';
import * as umbrella from './index.js';

describe('fascicle umbrella re-export', () => {
  it('re-exports run, describe, and flow_schema', () => {
    expect(typeof umbrella.run).toBe('function');
    expect(typeof umbrella.describe).toBe('function');
    expect(umbrella.flow_schema).toBeDefined();
    expect(typeof umbrella.run.stream).toBe('function');
  });

  it('exposes describe.json as a namespace member', () => {
    expect(typeof umbrella.describe.json).toBe('function');
  });

  it('re-exports every composer factory', () => {
    const expected = [
      'step',
      'sequence',
      'parallel',
      'branch',
      'map',
      'pipe',
      'retry',
      'fallback',
      'timeout',
      'adversarial',
      'ensemble',
      'tournament',
      'consensus',
      'checkpoint',
      'suspend',
      'scope',
      'stash',
      'use',
    ] as const;
    for (const name of expected) {
      expect(
        typeof umbrella[name as keyof typeof umbrella],
        `expected umbrella to export ${name}`,
      ).toBe('function');
    }
  });

  it('re-exports every typed error as a constructor', () => {
    expect(typeof umbrella.timeout_error).toBe('function');
    expect(typeof umbrella.suspended_error).toBe('function');
    expect(typeof umbrella.resume_validation_error).toBe('function');
    expect(typeof umbrella.aborted_error).toBe('function');
    expect(typeof umbrella.describe_cycle_error).toBe('function');
  });

  it('re-exports create_engine and model_call', () => {
    expect(typeof umbrella.create_engine).toBe('function');
    expect(typeof umbrella.model_call).toBe('function');
  });

  it('the umbrella run executes an atomic step end-to-end', async () => {
    const flow = umbrella.step('inc', (n: number) => n + 1);
    const result = await umbrella.run(flow, 1, { install_signal_handlers: false });
    expect(result).toBe(2);
  });
});
