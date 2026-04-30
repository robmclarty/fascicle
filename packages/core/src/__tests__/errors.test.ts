import { describe, expect, it } from 'vitest';
import {
  aborted_error,
  resume_validation_error,
  suspended_error,
  timeout_error,
} from '../errors.js';

describe('typed errors', () => {
  it('timeout_error carries the declared kind and timeout_ms', () => {
    const err = new timeout_error('too slow', 250);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('timeout_error');
    expect(err.name).toBe('timeout_error');
    expect(err.timeout_ms).toBe(250);
    expect(err.message).toBe('too slow');
  });

  it('suspended_error defaults its message from the suspend id', () => {
    const err = new suspended_error('approval', { step: 'ship' });
    expect(err.kind).toBe('suspended_error');
    expect(err.suspend_id).toBe('approval');
    expect(err.payload).toEqual({ step: 'ship' });
    expect(err.message).toBe('suspended at approval');
  });

  it('suspended_error accepts an explicit message override', () => {
    const err = new suspended_error('approval', null, 'needs human');
    expect(err.message).toBe('needs human');
  });

  it('resume_validation_error preserves its issues payload', () => {
    const issues = [{ path: 'foo', error: 'bad' }];
    const err = new resume_validation_error('bad resume', issues);
    expect(err.kind).toBe('resume_validation_error');
    expect(err.issues).toBe(issues);
  });

  it('aborted_error defaults to message "aborted" with no reason', () => {
    const err = new aborted_error();
    expect(err.kind).toBe('aborted_error');
    expect(err.message).toBe('aborted');
    expect(err.reason).toBeUndefined();
  });

  it('aborted_error carries the provided reason', () => {
    const err = new aborted_error('received SIGINT', { reason: { signal: 'SIGINT' } });
    expect(err.reason).toEqual({ signal: 'SIGINT' });
  });

  it('aborted_error accepts engine metadata (step_index, tool_call_in_flight)', () => {
    const err = new aborted_error('aborted', {
      reason: 'abort',
      step_index: 3,
      tool_call_in_flight: { id: 't-1', name: 'search' },
    });
    expect(err.step_index).toBe(3);
    expect(err.tool_call_in_flight).toEqual({ id: 't-1', name: 'search' });
  });
});
