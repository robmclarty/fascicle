import { describe, expect, it } from 'vitest';
import { DEFAULT_ALIASES } from './aliases.js';
import { DEFAULT_PRICING } from './pricing.js';

describe('frozen defaults', () => {
  it('throws when mutating DEFAULT_ALIASES', () => {
    expect(() => {
      (DEFAULT_ALIASES as Record<string, unknown>)['injected'] = { provider: 'x', model_id: 'y' };
    }).toThrow();
  });

  it('throws when mutating DEFAULT_PRICING', () => {
    expect(() => {
      (DEFAULT_PRICING as Record<string, unknown>)['injected'] = {
        input_per_million: 0,
        output_per_million: 0,
      };
    }).toThrow();
  });
});
