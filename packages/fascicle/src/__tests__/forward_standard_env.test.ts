import { describe, expect, it } from 'vitest';
import { forward_standard_env } from '../forward_standard_env.js';

describe('forward_standard_env', () => {
  it('copies PATH from process.env when present', () => {
    const marker = 'test-path-value';
    const prior = process.env['PATH'];
    process.env['PATH'] = marker;
    try {
      const env = forward_standard_env();
      expect(env['PATH']).toBe(marker);
    } finally {
      if (prior === undefined) delete process.env['PATH'];
      else process.env['PATH'] = prior;
    }
  });

  it('skips keys absent from process.env', () => {
    const prior = process.env['TMPDIR'];
    delete process.env['TMPDIR'];
    try {
      const env = forward_standard_env();
      expect(Object.prototype.hasOwnProperty.call(env, 'TMPDIR')).toBe(false);
    } finally {
      if (prior !== undefined) process.env['TMPDIR'] = prior;
    }
  });

  it('only forwards the standard key allowlist', () => {
    const extra = 'AGENT_KIT_FORWARD_STANDARD_ENV_EXTRA';
    process.env[extra] = 'yes';
    try {
      const env = forward_standard_env();
      expect(env[extra]).toBeUndefined();
    } finally {
      delete process.env[extra];
    }
  });
});
