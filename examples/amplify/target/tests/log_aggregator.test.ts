/**
 * Locked regression tests — the gate.
 *
 * These pin the observable behavior of `aggregate(log_text, services)`.
 * The amplify harness runs these against every candidate; any candidate
 * that fails dies at the gate stage and is never measured for speed.
 *
 * Mutations that "win" by deleting features get rejected here, by design.
 */

import { describe, it, expect } from 'vitest';

import { aggregate } from '../src/log_aggregator.js';

const SAMPLE = [
  '2024-01-01T00:00:00Z INFO  request=42 service=auth ok',
  '2024-01-01T00:00:01Z ERROR request=43 service=auth db timeout',
  '2024-01-01T00:00:02Z ERROR request=44 service=auth invalid token',
  '2024-01-01T00:00:03Z WARN  request=45 service=billing slow',
  '2024-01-01T00:00:04Z ERROR request=46 service=billing card declined',
  '2024-01-01T00:00:05Z INFO  request=47 service=search ok',
  '2024-01-01T00:00:06Z ERROR request=48 service=auth rate-limited',
  '',
].join('\n');

describe('aggregate', () => {
  it('counts ERROR entries per service', () => {
    const counts = aggregate(SAMPLE, ['auth', 'billing', 'search']);
    expect(counts).toStrictEqual({ auth: 3, billing: 1, search: 0 });
  });

  it('returns zero for services that never appear', () => {
    const counts = aggregate(SAMPLE, ['ghost']);
    expect(counts).toStrictEqual({ ghost: 0 });
  });

  it('handles an empty log', () => {
    const counts = aggregate('', ['auth']);
    expect(counts).toStrictEqual({ auth: 0 });
  });

  it('does not count INFO or WARN lines as errors', () => {
    const only_info_warn = [
      'INFO  service=auth ok',
      'WARN  service=auth slow',
      'WARN  service=billing slow',
    ].join('\n');
    const counts = aggregate(only_info_warn, ['auth', 'billing']);
    expect(counts).toStrictEqual({ auth: 0, billing: 0 });
  });

  it('treats service names as exact tokens (auth does not match auth-svc)', () => {
    const text = [
      'ERROR service=auth lost',
      'ERROR service=auth-svc lost',
      'ERROR service=auth lost',
    ].join('\n');
    const counts = aggregate(text, ['auth']);
    expect(counts).toStrictEqual({ auth: 2 });
  });

  it('handles unicode in messages without crashing', () => {
    const text = [
      'ERROR service=auth user=ünïcødé reason=日本語',
      'ERROR service=auth message=💥 boom',
    ].join('\n');
    const counts = aggregate(text, ['auth']);
    expect(counts).toStrictEqual({ auth: 2 });
  });

  it('returns a frozen object', () => {
    const counts = aggregate(SAMPLE, ['auth']);
    expect(Object.isFrozen(counts)).toBe(true);
  });

  it('preserves the order and presence of every requested service', () => {
    const counts = aggregate(SAMPLE, ['billing', 'search', 'auth']);
    expect(Object.keys(counts)).toStrictEqual(['billing', 'search', 'auth']);
  });
});
