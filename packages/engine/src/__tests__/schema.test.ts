import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  build_repair_message,
  parse_with_schema,
  throw_schema_validation,
} from '../schema.js';
import { schema_validation_error } from '../errors.js';

const user_schema = z.object({ name: z.string(), age: z.number().int() });

describe('parse_with_schema', () => {
  it('returns ok: true on valid JSON matching the schema', () => {
    const outcome = parse_with_schema(user_schema, '{"name":"ada","age":36}');
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.value).toEqual({ name: 'ada', age: 36 });
    }
  });

  it('returns ok: false on malformed JSON', () => {
    const outcome = parse_with_schema(user_schema, '{not json');
    expect(outcome.ok).toBe(false);
  });

  it('returns ok: false on schema mismatch', () => {
    const outcome = parse_with_schema(user_schema, '{"name":"ada","age":"thirty"}');
    expect(outcome.ok).toBe(false);
  });
});

describe('build_repair_message', () => {
  it('produces a user-role message matching the canonical shape', () => {
    const message = build_repair_message(new Error('expected number, got string'));
    expect(message.role).toBe('user');
    expect(message.content as string).toContain('did not match the expected schema');
    expect(message.content as string).toContain('expected number, got string');
    expect(message.content as string).toContain('strictly conforms to the schema');
  });
});

describe('throw_schema_validation', () => {
  it('throws schema_validation_error with zod error and raw text', () => {
    const zerr = new Error('boom');
    try {
      throw_schema_validation(zerr, 'raw model output');
      expect.unreachable('should throw');
    } catch (err) {
      expect(err).toBeInstanceOf(schema_validation_error);
      expect((err as schema_validation_error).zod_error).toBe(zerr);
      expect((err as schema_validation_error).raw_text).toBe('raw model output');
    }
  });
});
