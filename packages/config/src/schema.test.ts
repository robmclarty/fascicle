import { describe, expect, it } from 'vitest';
import { CONFIG_SCHEMA } from './schema.js';

describe('CONFIG_SCHEMA', () => {
  it('defaults NODE_ENV to development when absent', () => {
    const parsed = CONFIG_SCHEMA.parse({});
    expect(parsed.NODE_ENV).toBe('development');
  });

  it('accepts all provider credentials as optional', () => {
    const parsed = CONFIG_SCHEMA.parse({});
    expect(parsed.ANTHROPIC_API_KEY).toBeUndefined();
    expect(parsed.OPENAI_API_KEY).toBeUndefined();
    expect(parsed.GOOGLE_API_KEY).toBeUndefined();
  });

  it('trims whitespace from string values', () => {
    const parsed = CONFIG_SCHEMA.parse({ ANTHROPIC_API_KEY: '  sk-test  ' });
    expect(parsed.ANTHROPIC_API_KEY).toBe('sk-test');
  });

  it('rejects empty-string credentials', () => {
    const result = CONFIG_SCHEMA.safeParse({ ANTHROPIC_API_KEY: '' });
    expect(result.success).toBe(false);
  });

  it('rejects unknown NODE_ENV values', () => {
    const result = CONFIG_SCHEMA.safeParse({ NODE_ENV: 'staging' });
    expect(result.success).toBe(false);
  });
});
