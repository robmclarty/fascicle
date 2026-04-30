import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { resume_validation_error, suspended_error } from '../errors.js';
import { run } from '../runner.js';
import { step } from '../step.js';
import { suspend } from '../suspend.js';

describe('suspend', () => {
  it('calls on(input, ctx) and throws suspended_error on first encounter (criterion 15)', async () => {
    const on_spy = vi.fn(async () => {});
    const flow = suspend({
      id: 'approve',
      on: on_spy,
      resume_schema: z.object({ approved: z.boolean() }),
      combine: async (_: { brief: string }, resume, _ctx) =>
        resume.approved ? 'shipped' : 'rejected',
    });

    await expect(
      run(flow, { brief: 'hi' }, { install_signal_handlers: false }),
    ).rejects.toBeInstanceOf(suspended_error);
    expect(on_spy).toHaveBeenCalledTimes(1);
  });

  it('calls combine with valid resume data and returns the result', async () => {
    const flow = suspend({
      id: 'approve',
      on: async () => {},
      resume_schema: z.object({ decision: z.enum(['yes', 'no']) }),
      combine: (_: { brief: string }, resume) => `decision: ${resume.decision}`,
    });

    const result = await run(flow, { brief: 'hi' }, {
      install_signal_handlers: false,
      resume_data: { approve: { decision: 'yes' } },
    });
    expect(result).toBe('decision: yes');
  });

  it('throws resume_validation_error with flattened zod issues on invalid resume (F5)', async () => {
    const schema = z.object({ n: z.number(), s: z.string() });
    const combine_spy = vi.fn(() => 'never');
    const flow = suspend({
      id: 'x',
      on: async () => {},
      resume_schema: schema,
      combine: combine_spy,
    });

    let caught: unknown = undefined;
    try {
      await run(flow, 'input', {
        install_signal_handlers: false,
        resume_data: { x: { n: 'not-a-number', s: 42 } },
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(resume_validation_error);
    if (caught instanceof resume_validation_error) {
      const issues = caught.issues as { formErrors?: unknown; fieldErrors?: unknown };
      expect(issues.fieldErrors).toBeDefined();
    }
    expect(combine_spy).not.toHaveBeenCalled();
  });

  it('allows re-run with valid data after invalid resume (F5)', async () => {
    const schema = z.object({ decision: z.string() });
    const flow = suspend({
      id: 'x',
      on: async () => {},
      resume_schema: schema,
      combine: (_: string, r) => `ok: ${r.decision}`,
    });

    await expect(
      run(flow, 'input', {
        install_signal_handlers: false,
        resume_data: { x: { decision: 42 } },
      }),
    ).rejects.toBeInstanceOf(resume_validation_error);

    const result = await run(flow, 'input', {
      install_signal_handlers: false,
      resume_data: { x: { decision: 'yes' } },
    });
    expect(result).toBe('ok: yes');
  });

  it('accepts a step returned from combine and dispatches it', async () => {
    const inner = step('after', (i: string) => `post:${i}`);
    const flow = suspend({
      id: 'go',
      on: async () => {},
      resume_schema: z.object({ ok: z.boolean() }),
      combine: (_input: string, _resume) => inner,
    });

    const result = await run(flow, 'hello', {
      install_signal_handlers: false,
      resume_data: { go: { ok: true } },
    });
    expect(result).toBe('post:hello');
  });
});
