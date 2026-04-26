/**
 * Auth tests (spec §4, §6.1, §12 #20, #21; F19, F20).
 *
 * Covers build_env semantics for every AuthMode, the synchronous validator for
 * auth_mode: 'api_key' missing api_key, stderr pattern matching against
 * CLI_AUTH_ERROR_PATTERNS, and the frozen-constants invariant.
 */

import { readFile } from 'node:fs/promises';
import { afterEach, describe, expect, it } from 'vitest';
import {
  build_env,
  stderr_is_auth_failure,
  validate_auth_config,
} from '../../../src/providers/claude_cli/auth.js';
import {
  CLI_AUTH_ERROR_PATTERNS,
  DEFAULT_SETTING_SOURCES,
} from '../../../src/providers/claude_cli/constants.js';
import { engine_config_error } from '../../../src/errors.js';
import { create_claude_cli_adapter } from '../../../src/providers/claude_cli/index.js';
import type { AliasTarget } from '../../../src/types.js';
import {
  MOCK_CLAUDE_PATH,
  build_mock_env,
  success_ops,
  write_mock_script,
  type MockScriptHandle,
} from './fixtures/mock_helpers.js';

const cleanup_stack: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanup_stack.length > 0) {
    const fn = cleanup_stack.pop();
    if (fn !== undefined) await fn();
  }
});

async function track(handle: MockScriptHandle): Promise<MockScriptHandle> {
  cleanup_stack.push(handle.cleanup);
  return handle;
}

const alias_target: AliasTarget = {
  provider: 'claude_cli',
  model_id: 'claude-sonnet-4-6',
};

describe('validate_auth_config', () => {
  it('§12 #21 — api_key mode with missing api_key throws engine_config_error', () => {
    expect(() => validate_auth_config({ auth_mode: 'api_key' })).toThrow(engine_config_error);
  });

  it('F20 — api_key mode with empty-string api_key throws', () => {
    expect(() => validate_auth_config({ auth_mode: 'api_key', api_key: '' })).toThrow(
      engine_config_error,
    );
  });

  it('api_key mode with non-empty api_key passes', () => {
    expect(() => validate_auth_config({ auth_mode: 'api_key', api_key: 'k' })).not.toThrow();
  });

  it('auto mode does not require api_key', () => {
    expect(() => validate_auth_config({ auth_mode: 'auto' })).not.toThrow();
    expect(() => validate_auth_config({})).not.toThrow();
  });

  it('oauth mode does not require api_key', () => {
    expect(() => validate_auth_config({ auth_mode: 'oauth' })).not.toThrow();
  });

  it('throws engine_config_error with provider: claude_cli', () => {
    try {
      validate_auth_config({ auth_mode: 'api_key' });
    } catch (err) {
      expect(err).toBeInstanceOf(engine_config_error);
      if (err instanceof engine_config_error) {
        expect(err.provider).toBe('claude_cli');
      }
    }
  });
});

describe('build_env — auth_mode: oauth', () => {
  it('§12 #20 — strips ANTHROPIC_API_KEY supplied via caller env', () => {
    const env = build_env(
      { api_key: 'config-key', inherit_env: false },
      { ANTHROPIC_API_KEY: 'caller-key', PATH: '/bin' },
      'oauth',
    );
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
  });

  it('never injects ANTHROPIC_API_KEY from provider config under oauth', () => {
    const env = build_env({ api_key: 'config-key', inherit_env: false }, undefined, 'oauth');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
  });

  it('inherit_env: false keeps env strict (no process.env)', () => {
    const env = build_env({ inherit_env: false }, undefined, 'oauth');
    expect(Object.keys(env).length).toBe(0);
  });

  it('inherits process.env by default (needed for CLI to reach logged-in session)', () => {
    const marker = 'AGENT_KIT_OAUTH_INHERIT_TEST';
    process.env[marker] = 'yes';
    try {
      const env = build_env({}, undefined, 'oauth');
      expect(env[marker]).toBe('yes');
    } finally {
      delete process.env[marker];
    }
  });

  it('caller_env overrides inherited process.env values under oauth', () => {
    const marker = 'AGENT_KIT_OAUTH_OVERRIDE_TEST';
    process.env[marker] = 'from-process';
    try {
      const env = build_env({}, { [marker]: 'from-caller' }, 'oauth');
      expect(env[marker]).toBe('from-caller');
    } finally {
      delete process.env[marker];
    }
  });

  it('scrubs ANTHROPIC_API_KEY inherited from process.env under oauth', () => {
    const prior = process.env['ANTHROPIC_API_KEY'];
    process.env['ANTHROPIC_API_KEY'] = 'process-leak';
    try {
      const env = build_env({}, undefined, 'oauth');
      expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    } finally {
      if (prior === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prior;
    }
  });
});

describe('build_env — auth_mode: api_key', () => {
  it('does not inherit process.env (inherit_env is oauth-only)', () => {
    const marker = 'AGENT_KIT_APIKEY_INHERIT_TEST';
    process.env[marker] = 'yes';
    try {
      const env = build_env({ api_key: 'k', inherit_env: true }, undefined, 'api_key');
      expect(env[marker]).toBeUndefined();
    } finally {
      delete process.env[marker];
    }
  });

  it('sets ANTHROPIC_API_KEY from provider config', () => {
    const env = build_env({ api_key: 'sk-abc' }, undefined, 'api_key');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-abc');
  });

  it('caller env is merged then overridden by config api_key', () => {
    const env = build_env(
      { api_key: 'sk-config' },
      { ANTHROPIC_API_KEY: 'sk-caller', EXTRA: '1' },
      'api_key',
    );
    expect(env['ANTHROPIC_API_KEY']).toBe('sk-config');
    expect(env['EXTRA']).toBe('1');
  });

  it('empty api_key passes through as empty string (validator catches earlier)', () => {
    const env = build_env({ api_key: '' }, undefined, 'api_key');
    expect(env['ANTHROPIC_API_KEY']).toBe('');
  });
});

describe('build_env — auth_mode: auto', () => {
  it('sets ANTHROPIC_API_KEY when provider config has one', () => {
    const env = build_env({ api_key: 'sk' }, undefined, 'auto');
    expect(env['ANTHROPIC_API_KEY']).toBe('sk');
  });

  it('leaves ANTHROPIC_API_KEY unset when config has no api_key', () => {
    const env = build_env({}, { PATH: '/bin' }, 'auto');
    expect(env['ANTHROPIC_API_KEY']).toBeUndefined();
    expect(env['PATH']).toBe('/bin');
  });

  it('caller env ANTHROPIC_API_KEY wins when provider config has none', () => {
    const env = build_env({}, { ANTHROPIC_API_KEY: 'caller' }, 'auto');
    expect(env['ANTHROPIC_API_KEY']).toBe('caller');
  });

  it('provider config api_key overrides caller env', () => {
    const env = build_env(
      { api_key: 'config' },
      { ANTHROPIC_API_KEY: 'caller' },
      'auto',
    );
    expect(env['ANTHROPIC_API_KEY']).toBe('config');
  });

  it('ignores non-string caller env values', () => {
    const env = build_env(
      {},
      { PATH: '/bin', BAD: 42 as unknown as string },
      'auto',
    );
    expect(env['PATH']).toBe('/bin');
    expect(env['BAD']).toBeUndefined();
  });
});

describe('stderr_is_auth_failure — F19 patterns', () => {
  it('returns false for empty stderr', () => {
    expect(stderr_is_auth_failure('')).toBe(false);
  });

  it('returns false for unrelated errors', () => {
    expect(stderr_is_auth_failure('network error: socket hang up')).toBe(false);
  });

  for (const pattern of CLI_AUTH_ERROR_PATTERNS) {
    it(`F19 — matches '${pattern}' case-insensitively`, () => {
      expect(stderr_is_auth_failure(pattern)).toBe(true);
      expect(stderr_is_auth_failure(pattern.toUpperCase())).toBe(true);
      expect(
        stderr_is_auth_failure(`prefix line\n${pattern.toUpperCase()} suffix\n`),
      ).toBe(true);
    });
  }
});

describe('end-to-end auth-scrub through adapter spawn (§12 #20, F20, criterion 4/14)', () => {
  it(
    'oauth mode strips ANTHROPIC_API_KEY from the spawned subprocess env',
    async () => {
      const handle = await track(await write_mock_script(success_ops('ok')));
      const adapter = create_claude_cli_adapter({
        binary: MOCK_CLAUDE_PATH,
        auth_mode: 'oauth',
        api_key: 'config-secret-should-not-leak',
      });
      cleanup_stack.push(() => adapter.dispose());

      const result = await adapter.generate(
        {
          model: 'claude-sonnet-4-6',
          prompt: 'hello',
          provider_options: {
            claude_cli: {
              env: build_mock_env({
                MOCK_CLAUDE_SCRIPT: handle.script_path,
                MOCK_CLAUDE_RECORD: handle.record_path,
                ANTHROPIC_API_KEY: 'caller-secret-should-not-leak',
              }),
            },
          },
        },
        alias_target,
      );
      expect(result.content).toBe('ok');

      const snapshot = JSON.parse(await readFile(handle.record_path, 'utf8')) as {
        env: Record<string, string>;
      };
      expect(snapshot.env['ANTHROPIC_API_KEY']).toBeUndefined();
      // Neither the provider config's api_key nor the caller-supplied value
      // reaches the subprocess under oauth.
      for (const v of Object.values(snapshot.env)) {
        expect(v).not.toBe('config-secret-should-not-leak');
        expect(v).not.toBe('caller-secret-should-not-leak');
      }
    },
    15_000,
  );

  it('api_key mode injects provider config api_key into the spawned subprocess env', async () => {
    const handle = await track(await write_mock_script(success_ops('ok')));
    const adapter = create_claude_cli_adapter({
      binary: MOCK_CLAUDE_PATH,
      auth_mode: 'api_key',
      api_key: 'sk-test-api-key',
    });
    cleanup_stack.push(() => adapter.dispose());

    await adapter.generate(
      {
        model: 'claude-sonnet-4-6',
        prompt: 'hello',
        provider_options: {
          claude_cli: {
            env: build_mock_env({
              MOCK_CLAUDE_SCRIPT: handle.script_path,
              MOCK_CLAUDE_RECORD: handle.record_path,
            }),
          },
        },
      },
      alias_target,
    );

    const snapshot = JSON.parse(await readFile(handle.record_path, 'utf8')) as {
      env: Record<string, string>;
    };
    expect(snapshot.env['ANTHROPIC_API_KEY']).toBe('sk-test-api-key');
  });
});

describe('frozen constants (architectural validation #15)', () => {
  it('CLI_AUTH_ERROR_PATTERNS is frozen; push throws in strict mode', () => {
    expect(Object.isFrozen(CLI_AUTH_ERROR_PATTERNS)).toBe(true);
    expect(() => {
      (CLI_AUTH_ERROR_PATTERNS as unknown as string[]).push('new-pattern');
    }).toThrow(TypeError);
  });

  it('CLI_AUTH_ERROR_PATTERNS rejects index assignment', () => {
    expect(() => {
      (CLI_AUTH_ERROR_PATTERNS as unknown as string[])[0] = 'mutated';
    }).toThrow(TypeError);
  });

  it('DEFAULT_SETTING_SOURCES is frozen', () => {
    expect(Object.isFrozen(DEFAULT_SETTING_SOURCES)).toBe(true);
    expect(() => {
      (DEFAULT_SETTING_SOURCES as unknown as string[]).push('user');
    }).toThrow(TypeError);
  });
});
