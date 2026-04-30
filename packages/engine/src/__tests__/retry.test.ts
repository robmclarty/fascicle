import { describe, expect, it } from 'vitest';
import {
  DEFAULT_RETRY,
  parse_retry_after,
  retry_with_policy,
} from '../retry.js';
import { aborted_error, provider_error, rate_limit_error } from '../errors.js';
import type { RetryPolicy } from '../types.js';

const FAST_POLICY: RetryPolicy = {
  max_attempts: 3,
  initial_delay_ms: 10,
  max_delay_ms: 100,
  retry_on: ['rate_limit', 'provider_5xx', 'network'],
};

describe('DEFAULT_RETRY', () => {
  it('matches the documented defaults', () => {
    expect(DEFAULT_RETRY.max_attempts).toBe(3);
    expect(DEFAULT_RETRY.initial_delay_ms).toBe(500);
    expect(DEFAULT_RETRY.max_delay_ms).toBe(30_000);
    expect(DEFAULT_RETRY.retry_on).toEqual(['rate_limit', 'provider_5xx', 'network']);
  });
});

describe('parse_retry_after', () => {
  it('parses numeric seconds into ms', () => {
    expect(parse_retry_after('2')).toBe(2000);
    expect(parse_retry_after('0.5')).toBe(500);
  });

  it('parses HTTP-date forms into ms from now', () => {
    const future = new Date(Date.now() + 3000).toUTCString();
    const result = parse_retry_after(future);
    expect(result).toBeDefined();
    expect(result!).toBeGreaterThanOrEqual(2000);
    expect(result!).toBeLessThanOrEqual(3500);
  });

  it('returns undefined for null/empty/invalid', () => {
    expect(parse_retry_after(null)).toBeUndefined();
    expect(parse_retry_after(undefined)).toBeUndefined();
    expect(parse_retry_after('')).toBeUndefined();
    expect(parse_retry_after('not-a-date')).toBeUndefined();
  });
});

describe('retry_with_policy', () => {
  it('returns the value on first success', async () => {
    const result = await retry_with_policy(async () => 42, FAST_POLICY);
    expect(result).toBe(42);
  });

  it('retries 429 with numeric Retry-After and waits at least that long', async () => {
    let attempts = 0;
    const start = Date.now();
    const result = await retry_with_policy(async () => {
      attempts += 1;
      if (attempts < 2) {
        throw { kind: 'rate_limit', retry_after_ms: 200, status: 429 };
      }
      return 'ok';
    }, FAST_POLICY);
    const elapsed = Date.now() - start;
    expect(result).toBe('ok');
    expect(attempts).toBe(2);
    expect(elapsed).toBeGreaterThanOrEqual(180);
  });

  it('retries 5xx with exponential backoff bounded by max_delay_ms', async () => {
    let attempts = 0;
    const start = Date.now();
    const result = await retry_with_policy(async () => {
      attempts += 1;
      if (attempts < 3) throw { kind: 'provider_5xx', status: 503 };
      return 'ok';
    }, FAST_POLICY);
    const elapsed = Date.now() - start;
    expect(result).toBe('ok');
    expect(attempts).toBe(3);
    expect(elapsed).toBeLessThan(FAST_POLICY.max_delay_ms * FAST_POLICY.max_attempts + 500);
  });

  it('rejects with aborted_error when abort fires during wait', async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    let attempts = 0;
    await expect(
      retry_with_policy(
        async () => {
          attempts += 1;
          throw { kind: 'rate_limit', retry_after_ms: 1000 };
        },
        { ...FAST_POLICY, max_attempts: 5 },
        controller.signal,
      ),
    ).rejects.toBeInstanceOf(aborted_error);
    expect(attempts).toBe(1);
  });

  it('does not retry 4xx failures outside rate_limit', async () => {
    let attempts = 0;
    const fail = new Error('bad request');
    await expect(
      retry_with_policy(
        async () => {
          attempts += 1;
          throw fail;
        },
        FAST_POLICY,
      ),
    ).rejects.toBe(fail);
    expect(attempts).toBe(1);
  });

  it('throws rate_limit_error after max_attempts', async () => {
    let attempts = 0;
    try {
      await retry_with_policy(async () => {
        attempts += 1;
        throw { kind: 'rate_limit', status: 429, retry_after_ms: 10 };
      }, FAST_POLICY);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(rate_limit_error);
      expect((err as rate_limit_error).attempts).toBe(FAST_POLICY.max_attempts);
    }
    expect(attempts).toBe(FAST_POLICY.max_attempts);
  });

  it('throws provider_error after max_attempts for 5xx', async () => {
    try {
      await retry_with_policy(async () => {
        throw { kind: 'provider_5xx', status: 500, body: 'boom' };
      }, FAST_POLICY);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(provider_error);
      expect((err as provider_error).status).toBe(500);
      expect((err as provider_error).cause_kind).toBe('provider_5xx');
    }
  });

  it('throws provider_error after max_attempts for network kind', async () => {
    try {
      await retry_with_policy(async () => {
        throw { kind: 'network', message: 'ECONNRESET' };
      }, FAST_POLICY);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(provider_error);
      expect((err as provider_error).cause_kind).toBe('network');
    }
  });

  it('does not retry a failure class absent from retry_on', async () => {
    const policy: RetryPolicy = { ...FAST_POLICY, retry_on: ['rate_limit'] };
    let attempts = 0;
    try {
      await retry_with_policy(async () => {
        attempts += 1;
        throw { kind: 'provider_5xx', status: 503 };
      }, policy);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as { kind?: string }).kind).toBe('provider_5xx');
    }
    expect(attempts).toBe(1);
  });
});
